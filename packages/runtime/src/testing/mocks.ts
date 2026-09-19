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

/**
 * 极简假 D1：只认运行时 events.ts 与 dedupe.ts 用到的几条语句，把行存进数组。
 * 其他 SQL 直接抛错，避免测试静默通过。
 *
 * 注意它只能验证语句的**逻辑**（冲突时 changes 为 0），证明不了 D1 在并发
 * isolate 下的原子性——那是平台保证，只有真 D1 才测得到。
 */
export function createD1(): D1Database & { readonly rows: Array<Record<string, unknown>> } {
  const rows: Array<Record<string, unknown>> = []
  const columns = ['id', 'ts', 'event', 'scene', 'user_id', 'target_id', 'content', 'matched', 'errors', 'outbox', 'failed']
  /** 去重表与事件表分开存，两者都以 id 为主键 */
  const seen: Array<Record<string, unknown>> = []
  const prepare = (sql: string) => {
    let params: unknown[] = []
    const stmt = {
      bind(...p: unknown[]) {
        params = p
        return stmt
      },
      async run() {
        if (sql.startsWith('INSERT OR REPLACE')) {
          const row = Object.fromEntries(columns.map((c, i) => [c, params[i]]))
          const i = rows.findIndex((r) => r.id === row.id)
          if (i >= 0) rows[i] = row
          else rows.push(row)
          return { meta: { changes: 1 } }
        }
        // 主键冲突即忽略，changes 为 0——dedupe 靠这个语义判断是不是首次
        if (sql.startsWith('INSERT OR IGNORE')) {
          const [id, ts] = params as [string, number]
          if (seen.some((r) => r.id === id)) return { meta: { changes: 0 } }
          seen.push({ id, ts })
          return { meta: { changes: 1 } }
        }
        if (sql.includes('DELETE FROM rt_seen_events')) {
          const cutoff = params[0] as number
          const before = seen.length
          for (let i = seen.length - 1; i >= 0; i--) {
            if ((seen[i]!.ts as number) < cutoff) seen.splice(i, 1)
          }
          return { meta: { changes: before - seen.length } }
        }
        if (sql.startsWith('DELETE FROM')) return { meta: { changes: 0 } }
        throw new Error(`fake D1 不支持：${sql}`)
      },
      async all() {
        if (!sql.startsWith('SELECT *')) throw new Error(`fake D1 不支持：${sql}`)
        const before = sql.includes('ts <') ? (params.shift() as number) : Infinity
        const limit = params[0] as number
        const results = [...rows].filter((r) => (r.ts as number) < before).sort((a, b) => (b.ts as number) - (a.ts as number)).slice(0, limit)
        return { results }
      },
      async first() {
        if (!sql.startsWith('SELECT COUNT')) throw new Error(`fake D1 不支持：${sql}`)
        const since = params[0] as number
        const recent = rows.filter((r) => (r.ts as number) >= since)
        return { total: rows.length, last24h: recent.length, errors24h: recent.filter((r) => r.errors !== '[]' || (r.failed as number) > 0).length }
      },
    }
    return stmt
  }
  return {
    rows,
    prepare,
    async exec() {
      return { count: 0, duration: 0 }
    },
    batch: async () => [],
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database & { readonly rows: Array<Record<string, unknown>> }
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

/**
 * 清单存储（manifestStore.ts）专用的极简假 D1：rt_manifest_plugins 与 rt_installs 两张表，
 * 行存进 Map。同样只验证语句逻辑，证明不了 D1 的平台原子性。
 */
export function createManifestD1(): D1Database & {
  plugins: Map<string, Record<string, unknown>>
  installs: Map<string, Record<string, unknown>>
  /** 插件表名 → 行数，喂给 purge.ts 的 sqlite_master 查询 */
  tables: Map<string, number>
} {
  const plugins = new Map<string, Record<string, unknown>>()
  const installs = new Map<string, Record<string, unknown>>()
  const tables = new Map<string, number>()
  let params: unknown[] = []

  const prepare = (sql: string) => {
    const stmt = {
      bind(...p: unknown[]) {
        params = p
        return stmt
      },
      async run() {
        if (sql.startsWith('INSERT OR REPLACE INTO rt_manifest_plugins')) {
          const [name, version, source, added_at, updated_at] = params as [string, string, string, number, number]
          const prev = plugins.get(name!)
          plugins.set(name!, { name, version, source, added_at: (prev?.added_at as number) ?? added_at, updated_at })
          return { meta: { changes: 1 } }
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
          return { meta: { changes: 1 } }
        }
        if (sql.startsWith('DELETE FROM rt_manifest_plugins')) {
          plugins.delete(params[0] as string)
          return { meta: { changes: 1 } }
        }
        if (sql.startsWith("UPDATE rt_installs SET status = 'building'")) {
          const [build_uuid, hash] = params as [string, string]
          for (const row of installs.values()) {
            if (row.status === 'pending' && row.manifest_hash === hash) {
              row.status = 'building'
              row.build_uuid = build_uuid
            }
          }
          return { meta: { changes: 1 } }
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
              row.error = error
            }
          }
          return { meta: { changes: 1 } }
        }
        throw new Error(`fake D1 不支持：${sql}`)
      },
      async all<T>() {
        if (sql.includes('FROM rt_manifest_plugins ORDER')) {
          const results = [...plugins.values()].sort((a, b) => (a.name as string).localeCompare(b.name as string))
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
    tables,
    prepare,
    async exec(sql: string) {
      const drop = /^DROP TABLE IF EXISTS (\w+)$/.exec(sql)
      if (drop) {
        tables.delete(drop[1]!)
        return { count: 1, duration: 0 }
      }
      return { count: 0, duration: 0 }
    },
    batch: async () => [],
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database & {
    plugins: Map<string, Record<string, unknown>>
    installs: Map<string, Record<string, unknown>>
    tables: Map<string, number>
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
