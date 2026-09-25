/**
 * 插件数据的作用域包装：KV 键前缀、D1 表名前缀、R2 键前缀。
 *
 * 单独成模块是因为有两个调用方——请求内装配 `ctx` 的 context.ts，以及 DO 构造时装配
 * `this.plugin` 的 durable.ts。放在 context.ts 里会让这两者互相 import 成环。
 *
 * 前缀不只是防撞名：框架凭它才知道某个插件建过哪些键 / 表 / 对象，卸载时才清得掉（见 purge.ts）。
 */
import type { ScopedDB, ScopedKV, ScopedR2, StoredObject } from '@qqbot/sdk'
import { flattenForExec, scopeSql, tablePrefix } from './sqlScope.js'

/** 插件数据的键前缀。卸载时按它枚举并清理，见 purge.ts */
export const kvPrefix = (plugin: string): string => `p:${plugin}:`
export const r2Prefix = (plugin: string): string => `p/${plugin}/`

export function createScopedKV(kv: KVNamespace, name: string): ScopedKV {
  const prefix = kvPrefix(name)
  return {
    get: (key) => kv.get(prefix + key),
    getJSON: <T>(key: string) => kv.get<T>(prefix + key, 'json'),
    async put(key, value, options) {
      const body = typeof value === 'string' ? value : JSON.stringify(value)
      await kv.put(prefix + key, body, options?.ttl ? { expirationTtl: Math.max(60, options.ttl) } : {})
    },
    delete: (key) => kv.delete(prefix + key),
    async list(sub = '') {
      const keys: string[] = []
      let cursor: string | undefined
      do {
        const page = await kv.list({ prefix: prefix + sub, ...(cursor ? { cursor } : {}) })
        for (const k of page.keys) keys.push(k.name.slice(prefix.length))
        cursor = page.list_complete ? undefined : page.cursor
      } while (cursor)
      return keys
    },
  }
}

export function createScopedR2(bucket: R2Bucket | undefined, name: string): ScopedR2 {
  const prefix = r2Prefix(name)
  if (!bucket) {
    const missing = async (): Promise<never> => {
      throw new Error('未绑定 R2（wrangler.jsonc 的 r2_buckets），插件无法使用 ctx.r2')
    }
    return { get: missing, getText: missing, getJSON: missing, getStream: missing, put: missing, delete: missing, head: missing, list: missing }
  }

  const strip = (key: string): string => key.slice(prefix.length)
  const meta = (o: R2Object): StoredObject => ({
    key: strip(o.key),
    size: o.size,
    uploadedAt: o.uploaded,
    ...(o.customMetadata && Object.keys(o.customMetadata).length ? { metadata: o.customMetadata } : {}),
  })

  return {
    async get(key) {
      return (await bucket.get(prefix + key))?.arrayBuffer() ?? null
    },
    async getText(key) {
      return (await bucket.get(prefix + key))?.text() ?? null
    },
    async getJSON<T>(key: string) {
      return ((await bucket.get(prefix + key))?.json<T>() ?? null) as Promise<T | null> | null
    },
    async getStream(key) {
      return (await bucket.get(prefix + key))?.body ?? null
    },
    async put(key, value, options) {
      await bucket.put(prefix + key, value, {
        ...(options?.contentType ? { httpMetadata: { contentType: options.contentType } } : {}),
        ...(options?.metadata ? { customMetadata: options.metadata } : {}),
      })
    },
    async delete(key) {
      await bucket.delete(Array.isArray(key) ? key.map((k) => prefix + k) : prefix + key)
    },
    async head(key) {
      const o = await bucket.head(prefix + key)
      return o ? meta(o) : null
    },
    async list(sub = '', options) {
      const objects: StoredObject[] = []
      let cursor: string | undefined
      do {
        // limit 是总数上限，不是每页；R2 单页最多 1000
        const remaining = options?.limit ? options.limit - objects.length : undefined
        if (remaining !== undefined && remaining <= 0) break
        const page = await bucket.list({
          prefix: prefix + sub,
          ...(remaining !== undefined ? { limit: Math.min(1000, remaining) } : {}),
          ...(cursor ? { cursor } : {}),
        })
        for (const o of page.objects) objects.push(meta(o))
        cursor = page.truncated ? page.cursor : undefined
      } while (cursor)
      return objects
    },
  }
}

export function createScopedDB(db: D1Database | undefined, name: string): ScopedDB {
  const prefix = tablePrefix(name)
  if (!db) {
    const missing = async () => {
      throw new Error('未绑定 D1（wrangler.jsonc 的 d1_databases），插件无法使用 ctx.db')
    }
    return { table: (n) => prefix + n, exec: missing, run: missing, all: missing, first: missing }
  }
  // 展开 {表名} 占位并拦下指向别处的表；见 sqlScope.ts
  const scope = (sql: string): string => scopeSql(sql, prefix)
  return {
    table: (n) => prefix + n,
    async exec(sql) {
      // D1 的 exec 按行拆语句，多行 DDL 不压成一行会从第一行就断掉，见 flattenForExec
      const flat = flattenForExec(scope(sql))
      if (flat.trim()) await db.exec(flat)
    },
    async run(sql, ...params) {
      const result = await db.prepare(scope(sql)).bind(...params).run()
      return { changes: result.meta.changes ?? 0 }
    },
    async all<T>(sql: string, ...params: unknown[]) {
      const result = await db.prepare(scope(sql)).bind(...params).all<T & Record<string, unknown>>()
      return result.results as T[]
    },
    async first<T>(sql: string, ...params: unknown[]) {
      return (await db.prepare(scope(sql)).bind(...params).first<T & Record<string, unknown>>()) as T | null
    },
  }
}
