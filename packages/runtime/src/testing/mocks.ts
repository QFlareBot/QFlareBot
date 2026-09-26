/** 运行时单测用的最小绑定实现 */
import { bytesToHex, getKeyPair } from '@qqbot/api'
import type { RuntimeEnv } from '../types.js'

export function createKV(): KVNamespace & { readonly store: Map<string, string> } {
  const store = new Map<string, string>()
  const kv = {
    store,
    async get(key: string, type?: string) {
      const v = store.get(key)
      if (v === undefined) return null
      return type === 'json' ? JSON.parse(v) : v
    },
    async put(key: string, value: string) {
      store.set(key, value)
    },
    async delete(key: string) {
      store.delete(key)
    },
    async list(options: { prefix?: string } = {}) {
      const prefix = options.prefix ?? ''
      return {
        keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
        cacheStatus: null,
      }
    },
  }
  return kv as unknown as KVNamespace & { readonly store: Map<string, string> }
}

interface FakeD1Extras {
  /** 实时调试记录表 rt_live_events：格子号 → 行（含 seq） */
  readonly rows: Array<Record<string, unknown>>
  /** 去重格子 rt_seen_ring：格子号 → 事件 id */
  readonly ring: Map<number, string>
  /** 实时调试开关 rt_live_debug 那一行 */
  readonly live: { until: number; seq: number }
  /** 升级前的旧去重表 rt_seen_events；null 表示这个库从没建过它 */
  readonly legacySeen: Array<{ id: string; ts: number }> | null
}

/**
 * 极简假 D1：只认运行时 events.ts 与 dedupe.ts 用到的几条语句。其他 SQL 直接抛错，避免测试静默通过。
 *
 * 注意它只能验证语句的**逻辑**（格子里已是同一个 id 时 changes 为 0、开关关着时一行不写），
 * 证明不了 D1 在并发 isolate 下的原子性——那是平台保证，只有真 D1 才测得到。
 *
 * `legacySeen` 模拟升级前的老库：旧去重表里还留着几行。
 */
export function createD1(options: { legacySeen?: Array<{ id: string; ts: number }> } = {}): D1Database & FakeD1Extras {
  const slots = new Map<number, Record<string, unknown>>()
  const ring = new Map<number, string>()
  const live = { until: 0, seq: 0 }
  const legacySeen = options.legacySeen ? [...options.legacySeen] : null
  /** 上次发送的指令面板 rt_qq_panels：场景 → 行 */
  const panels = new Map<string, { data: string; sent_at: number }>()
  const columns = ['id', 'ts', 'event', 'scene', 'user_id', 'target_id', 'content', 'matched', 'errors', 'outbox', 'failed']
  const noLegacy = () => new Error('D1_ERROR: no such table: rt_seen_events: SQLITE_ERROR')
  const prepare = (sql: string) => {
    let params: unknown[] = []
    const stmt = {
      bind(...p: unknown[]) {
        params = p
        return stmt
      },
      async run() {
        // 格子里已经是这个 id 就不改，changes 为 0——dedupe 靠这个语义判断是不是首次
        if (sql.startsWith('INSERT INTO rt_seen_ring')) {
          const [slot, id] = params as [number, string]
          if (ring.get(slot) === id) return { meta: { changes: 0 } }
          ring.set(slot, id)
          return { meta: { changes: 1 } }
        }
        if (sql.startsWith('DELETE FROM rt_seen_events WHERE ts < ?')) {
          if (!legacySeen) throw noLegacy()
          const cutoff = params[0] as number
          const before = legacySeen.length
          for (let i = legacySeen.length - 1; i >= 0; i--) if (legacySeen[i]!.ts < cutoff) legacySeen.splice(i, 1)
          return { meta: { changes: before - legacySeen.length } }
        }
        if (sql.startsWith('UPDATE rt_live_debug SET seq = seq + 1 WHERE id = 1 AND until > ?')) {
          if (!(live.until > (params[0] as number))) return { meta: { changes: 0 } }
          live.seq++
          return { meta: { changes: 1 } }
        }
        if (sql.startsWith('INSERT INTO rt_live_events')) {
          if (!(live.until > (params[columns.length] as number))) return { meta: { changes: 0 } }
          slots.set(live.seq % 50, { slot: live.seq % 50, seq: live.seq, ...Object.fromEntries(columns.map((c, i) => [c, params[i]])) })
          return { meta: { changes: 1 } }
        }
        if (sql.startsWith('UPDATE rt_live_debug SET until = ? WHERE id = 1')) {
          live.until = params[0] as number
          return { meta: { changes: 1 } }
        }
        if (sql.startsWith('INSERT INTO rt_qq_panels')) {
          const [scope, data, sentAt] = params as [string, string, number]
          panels.set(scope, { data, sent_at: sentAt })
          return { meta: { changes: 1 } }
        }
        throw new Error(`fake D1 不支持：${sql}`)
      },
      async all() {
        if (!sql.includes('FROM rt_live_events')) throw new Error(`fake D1 不支持：${sql}`)
        const before = sql.includes('ts <') ? (params[0] as number) : Infinity
        const limit = params.at(-1) as number
        const results = [...slots.values()]
          .filter((r) => (r.ts as number) < before)
          .sort((a, b) => (b.seq as number) - (a.seq as number))
          .slice(0, limit)
          .map(({ slot: _slot, seq: _seq, ...row }) => row)
        return { results }
      },
      async first() {
        if (sql.startsWith('SELECT COUNT(*) AS n FROM rt_seen_events')) {
          if (!legacySeen) throw noLegacy()
          return { n: legacySeen.length }
        }
        if (sql.startsWith('SELECT data, sent_at FROM rt_qq_panels')) return panels.get(params[0] as string) ?? null
        throw new Error(`fake D1 不支持：${sql}`)
      },
    }
    return stmt
  }
  return {
    get rows() {
      return [...slots.values()]
    },
    ring,
    live,
    legacySeen,
    prepare,
    async exec(sql: string) {
      if (sql === 'DELETE FROM rt_live_events') slots.clear()
      return { count: 0, duration: 0 }
    },
    // D1 的 batch 在一个事务里按顺序执行
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      const results = []
      for (const s of statements) results.push(await s.run())
      return results
    },
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database & FakeD1Extras
}

export function createExecutionContext(): ExecutionContext & { flush(): Promise<void> } {
  const pending: Promise<unknown>[] = []
  return {
    waitUntil: (p) => void pending.push(p),
    passThroughOnException() {},
    props: {},
    async flush() {
      await Promise.all(pending.splice(0))
    },
  } as unknown as ExecutionContext & { flush(): Promise<void> }
}

/** rt_manifest_plugins 最初的五列；后加的列由 manifestStore 的迁移补上 */
const LEGACY_PLUGIN_COLUMNS = ['name', 'version', 'source', 'added_at', 'updated_at']
const ADDED_PLUGIN_COLUMNS = ['manifest', 'build_error']

/**
 * 清单存储（manifestStore.ts）专用的极简假 D1：rt_manifest_plugins、rt_installs、rt_pending_cleanups
 * 三张表，行存进 Map。同样只验证语句逻辑，证明不了 D1 的平台原子性。
 *
 * `legacy: true` 模拟加列之前建的老库：插件表只有最初的五列，验证迁移会把缺的列补上。
 */
export function createManifestD1(options: { legacy?: boolean } = {}): D1Database & {
  plugins: Map<string, Record<string, unknown>>
  installs: Map<string, Record<string, unknown>>
  cleanups: Map<string, Record<string, unknown>>
  /** 插件表名 → 行数，喂给 purge.ts 的 sqlite_master 查询 */
  tables: Map<string, number>
  /** rt_manifest_plugins 当前有哪些列 */
  pluginColumns: Set<string>
  /** 执行过的 ALTER TABLE，断言迁移只补缺的列 */
  alters: string[]
} {
  const plugins = new Map<string, Record<string, unknown>>()
  const installs = new Map<string, Record<string, unknown>>()
  const cleanups = new Map<string, Record<string, unknown>>()
  const tables = new Map<string, number>()
  const pluginColumns = new Set([...LEGACY_PLUGIN_COLUMNS, ...(options.legacy ? [] : ADDED_PLUGIN_COLUMNS)])
  const alters: string[] = []

  const prepare = (sql: string) => {
    let params: unknown[] = []
    const stmt = {
      bind(...p: unknown[]) {
        params = p
        return stmt
      },
      async run() {
        if (sql.startsWith('INSERT OR REPLACE INTO rt_manifest_plugins')) {
          // 列没补上就写新列，真 D1 会报 no such column：这里同样报出来，免得迁移漏了测试还是绿的
          for (const c of ADDED_PLUGIN_COLUMNS) {
            if (!pluginColumns.has(c)) throw new Error(`D1_ERROR: table rt_manifest_plugins has no column named ${c}`)
          }
          const [name, version, source, manifest, added_at, updated_at] = params as [string, string, string, string | null, number, number]
          const prev = plugins.get(name!)
          plugins.set(name!, {
            name,
            version,
            source,
            manifest,
            build_error: null,
            added_at: (prev?.added_at as number) ?? added_at,
            updated_at,
          })
          return { meta: { changes: 1 } }
        }
        if (sql.startsWith('UPDATE rt_manifest_plugins SET build_error = ? WHERE name = ? AND source = ?')) {
          const [message, name, source] = params as [string, string, string]
          const row = plugins.get(name)
          if (row && row.source === source) row.build_error = message
          return { meta: { changes: row && row.source === source ? 1 : 0 } }
        }
        if (sql.startsWith('UPDATE rt_manifest_plugins SET build_error = NULL')) {
          for (const row of plugins.values()) row.build_error = null
          return { meta: { changes: 1 } }
        }
        if (sql.startsWith('INSERT OR REPLACE INTO rt_pending_cleanups')) {
          const [name, purge, ts] = params as [string, number, number]
          cleanups.set(name, { name, purge, ts })
          return { meta: { changes: 1 } }
        }
        if (sql.startsWith('DELETE FROM rt_pending_cleanups')) {
          const existed = cleanups.delete(params[0] as string)
          return { meta: { changes: existed ? 1 : 0 } }
        }
        if (sql.startsWith('INSERT INTO rt_installs')) {
          const [id, action, name, source, manifest_hash, build_uuid, cf_status, status, commit_hash, error, ts] = params as [
            string,
            string,
            string | null,
            string | null,
            string,
            string | null,
            string | null,
            string,
            string | null,
            string | null,
            number,
          ]
          installs.set(id!, { id, action, name, source, manifest_hash, build_uuid, cf_status, status, commit_hash, error, ts })
          // 保留策略：只留最近 100 条（与 insertInstall 的 prune 行为一致）
          const rows = [...installs.values()].sort((a, b) => (b.ts as number) - (a.ts as number))
          for (const old of rows.slice(100)) installs.delete(old.id as string)
          return { meta: { changes: 1 } }
        }
        if (sql.startsWith('DELETE FROM rt_installs')) return { meta: { changes: 0 } }
        // Cron 顺手清升级前的旧去重表；这个假库不存事件，删零行即可（随后的 COUNT 走下面的 first）
        if (sql.startsWith('DELETE FROM rt_seen_events')) return { meta: { changes: 0 } }
        if (sql.startsWith('DELETE FROM rt_manifest_plugins')) {
          plugins.delete(params[0] as string)
          return { meta: { changes: 1 } }
        }
        if (sql.startsWith("UPDATE rt_installs SET status = 'building'")) {
          const [build_uuid] = params as [string]
          for (const row of installs.values()) {
            if (row.status === 'pending') {
              row.status = 'building'
              row.build_uuid = build_uuid
            }
          }
          return { meta: { changes: 1 } }
        }
        if (sql.startsWith("UPDATE rt_installs SET status = 'ok' WHERE status = 'pending'")) {
          for (const row of installs.values()) if (row.status === 'pending') row.status = 'ok'
          return { meta: { changes: 1 } }
        }
        if (sql.startsWith('UPDATE rt_installs SET error = COALESCE(error, ?) WHERE build_uuid = ?')) {
          const [message, build_uuid] = params as [string, string]
          for (const row of installs.values()) {
            if (row.build_uuid === build_uuid) row.error = row.error ?? message
          }
          return { meta: { changes: 1 } }
        }
        if (sql.startsWith('UPDATE rt_installs SET status = ?, error = ? WHERE id = ?')) {
          const [status, error, id] = params as [string, string | null, string]
          const row = installs.get(id!)
          if (row) {
            row.status = status
            row.error = error
          }
          return { meta: { changes: row ? 1 : 0 } }
        }
        if (sql.startsWith('UPDATE rt_installs SET status = ?')) {
          const [status, cf_status, commit_hash, error, build_uuid] = params as [
            string,
            string | null,
            string | null,
            string | null,
            string,
          ]
          for (const row of installs.values()) {
            if (row.build_uuid === build_uuid) {
              row.status = status
              row.cf_status = cf_status
              row.commit_hash = commit_hash
              // 与 SQL 的 COALESCE(error, ?) 一致：已有的错误不被覆盖
              row.error = row.error ?? error
            }
          }
          return { meta: { changes: 1 } }
        }
        throw new Error(`fake D1 不支持：${sql}`)
      },
      async all<T>() {
        if (sql.startsWith('PRAGMA table_info(rt_manifest_plugins)')) {
          return { results: [...pluginColumns].map((name) => ({ name })) } as { results: T[] }
        }
        if (sql.includes('FROM rt_manifest_plugins ORDER')) {
          const results = [...plugins.values()].sort((a, b) => (a.name as string).localeCompare(b.name as string))
          return { results } as { results: T[] }
        }
        if (sql.includes('FROM rt_pending_cleanups')) {
          const results = [...cleanups.values()].sort((a, b) => (a.ts as number) - (b.ts as number))
          return { results } as { results: T[] }
        }
        if (sql.includes('FROM sqlite_master')) {
          const results = [...tables.keys()].filter((n) => n.startsWith('p_')).sort().map((name) => ({ name }))
          return { results } as { results: T[] }
        }
        if (sql.includes('FROM rt_installs ORDER')) {
          const limit = params[0] as number
          const results = [...installs.values()].sort((a, b) => (b.ts as number) - (a.ts as number)).slice(0, limit)
          return { results } as { results: T[] }
        }
        throw new Error(`fake D1 不支持：${sql}`)
      },
      async first<T>() {
        const count = /^SELECT COUNT\(\*\) AS n FROM (\w+)$/.exec(sql)
        if (count) return { n: tables.get(count[1]!) ?? 0 } as T
        if (sql.includes('WHERE name = ?')) {
          return (plugins.get(params[0] as string) ?? null) as T | null
        }
        throw new Error(`fake D1 不支持：${sql}`)
      },
    }
    return stmt
  }

  return {
    plugins,
    installs,
    cleanups,
    tables,
    pluginColumns,
    alters,
    prepare,
    async exec(sql: string) {
      const drop = /^DROP TABLE IF EXISTS (\w+)$/.exec(sql)
      if (drop) {
        tables.delete(drop[1]!)
        return { count: 1, duration: 0 }
      }
      const alter = /^ALTER TABLE rt_manifest_plugins ADD COLUMN (\w+) \w+$/.exec(sql)
      if (alter) {
        const column = alter[1]!
        if (pluginColumns.has(column)) throw new Error(`D1_ERROR: duplicate column name: ${column}: SQLITE_ERROR`)
        pluginColumns.add(column)
        alters.push(column)
        return { count: 1, duration: 0 }
      }
      return { count: 0, duration: 0 }
    },
    batch: async () => [],
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database & {
    plugins: Map<string, Record<string, unknown>>
    installs: Map<string, Record<string, unknown>>
    cleanups: Map<string, Record<string, unknown>>
    tables: Map<string, number>
    pluginColumns: Set<string>
    alters: string[]
  }
}

export const TEST_SECRET = 'DG5g3B4j9X2KOErG'
export const TEST_APPID = '1903864677'

/**
 * 极简假 R2：够验证键前缀与分页。`store` 的键是**加了前缀的真实键**，
 * 断言隔离时直接看它。
 */
export function createR2(): R2Bucket & { readonly store: Map<string, string> } {
  const store = new Map<string, string>()
  const obj = (key: string, body: string) => ({
    key,
    size: new TextEncoder().encode(body).byteLength,
    uploaded: new Date(0),
    customMetadata: undefined,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    text: async () => body,
    json: async () => JSON.parse(body) as unknown,
    body: null,
  })
  return {
    store,
    async get(key: string) {
      const v = store.get(key)
      return v === undefined ? null : obj(key, v)
    },
    async head(key: string) {
      const v = store.get(key)
      return v === undefined ? null : obj(key, v)
    },
    async put(key: string, value: unknown) {
      store.set(key, typeof value === 'string' ? value : new TextDecoder().decode(value as ArrayBuffer))
      return obj(key, String(value))
    },
    async delete(key: string | string[]) {
      for (const k of Array.isArray(key) ? key : [key]) store.delete(k)
    },
    // 每页最多 2 条，用来暴露只取首页的分页 bug
    async list(options?: { prefix?: string; limit?: number; cursor?: string }) {
      const all = [...store.keys()].filter((k) => k.startsWith(options?.prefix ?? '')).sort()
      const from = options?.cursor ? Number(options.cursor) : 0
      const size = Math.min(options?.limit ?? 2, 2)
      const slice = all.slice(from, from + size)
      const next = from + slice.length
      return {
        objects: slice.map((k) => obj(k, store.get(k)!)),
        truncated: next < all.length,
        cursor: String(next),
      }
    },
  } as unknown as R2Bucket & { readonly store: Map<string, string> }
}

export function createEnv(
  overrides: Partial<RuntimeEnv> = {},
): RuntimeEnv & { KV: ReturnType<typeof createKV>; DB: ReturnType<typeof createD1>; R2: ReturnType<typeof createR2> } {
  return {
    KV: createKV(),
    DB: createD1(),
    R2: createR2(),
    BOT_APPID: TEST_APPID,
    BOT_SECRET: TEST_SECRET,
    ADMIN_TOKEN: 'admin-token',
    ...overrides,
  } as RuntimeEnv & { KV: ReturnType<typeof createKV>; DB: ReturnType<typeof createD1>; R2: ReturnType<typeof createR2> }
}

/** 按 QQ 规则给事件请求签名（timestamp + body） */
export async function signedRequest(url: string, body: unknown, secret = TEST_SECRET, tsOverride?: number): Promise<Request> {
  const rawBody = JSON.stringify(body)
  const ts = String(tsOverride ?? Math.floor(Date.now() / 1000))
  const { privateKey } = await getKeyPair(secret)
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, new TextEncoder().encode(ts + rawBody))
  return new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-signature-ed25519': bytesToHex(sig),
      'x-signature-timestamp': ts,
    },
    body: rawBody,
  })
}

/** 模拟 QQ OpenAPI：记录发出的消息 */
export function createQQFetch() {
  const sent: Array<{ url: string; body: Record<string, unknown> }> = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    if (url.includes('getAppAccessToken')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 7200 }), { status: 200 })
    }
    if (url.includes('/users/@me')) {
      return new Response(
        JSON.stringify({ id: 'bot-1', username: '测试机器人', avatar: 'https://thirdqq.qlogo.cn/bot/640', bot: true }),
        { status: 200 },
      )
    }
    if (url.includes('/v2/panels')) {
      sent.push({ url, body: JSON.parse(String(init?.body ?? '{}')) })
      const method = String(init?.method ?? 'GET')
      if (method === 'POST') return new Response(JSON.stringify({ panel_id: 'p1' }), { status: 200 })
      if (method === 'DELETE') return new Response(JSON.stringify({}), { status: 200 })
      return new Response(JSON.stringify({ records: [], next_cursor: '', is_end: true }), { status: 200 })
    }
    if (url.includes('/v2/generate_url_link')) {
      return new Response(JSON.stringify({ url: 'https://q.qq.com/bot/invite' }), { status: 200 })
    }
    if (url.includes('/v2/menu')) {
      sent.push({ url, body: JSON.parse(String(init?.body ?? '{}')) })
      return new Response(JSON.stringify({ version: 1, menu: { items: [] } }), { status: 200 })
    }
    sent.push({ url, body: JSON.parse(String(init?.body ?? '{}')) })
    return new Response(JSON.stringify({ id: `sent-${sent.length}` }), { status: 200 })
  }
  return { fetchImpl, sent }
}

export function groupMessagePayload(content: string, id = `evt-${Math.random().toString(36).slice(2)}`) {
  return {
    op: 0,
    id: `GROUP_AT_MESSAGE_CREATE:${id}`,
    t: 'GROUP_AT_MESSAGE_CREATE',
    d: {
      id: `ROBOT1.0_${id}`,
      content: ` ${content}`,
      timestamp: new Date().toISOString(),
      author: { id: 'U1', member_openid: 'U1', username: '测试' },
      group_openid: 'G1',
    },
  }
}
