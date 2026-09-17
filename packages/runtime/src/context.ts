import type { BotApi, PluginContext, ScopedDB, ScopedKV } from '@qqbot/sdk'
import { createLogger } from './logger.js'
import type { PluginRegistry, RegisteredPlugin } from './registry.js'
import type { RuntimeEnv, Snapshot } from './types.js'

function createScopedKV(kv: KVNamespace, name: string): ScopedKV {
  const prefix = `p:${name}:`
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

function createScopedDB(db: D1Database, name: string): ScopedDB {
  const prefix = `p_${name.replace(/[^a-zA-Z0-9_]/g, '_')}_`
  return {
    table: (n) => prefix + n,
    async exec(sql) {
      await db.exec(sql)
    },
    async run(sql, ...params) {
      const result = await db.prepare(sql).bind(...params).run()
      return { changes: result.meta.changes ?? 0 }
    },
    async all<T>(sql: string, ...params: unknown[]) {
      const result = await db.prepare(sql).bind(...params).all<T & Record<string, unknown>>()
      return result.results as T[]
    },
    async first<T>(sql: string, ...params: unknown[]) {
      return (await db.prepare(sql).bind(...params).first<T & Record<string, unknown>>()) as T | null
    },
  }
}

export interface ContextFactoryOptions {
  env: RuntimeEnv
  execCtx: ExecutionContext
  registry: PluginRegistry
  snapshot: Snapshot
  api: BotApi
  botId: string
}

/**
 * 一次请求内为各插件构造上下文。
 * `ctx.service()` 是同步的，所以调用处理器前需先 `await prepare(plugin)` 解析其 depends 中的服务。
 */
export class ContextFactory {
  private readonly contexts = new Map<string, PluginContext<unknown>>()
  private readonly services = new Map<string, unknown>()
  private readonly pending = new Map<string, Promise<void>>()

  constructor(private readonly options: ContextFactoryOptions) {}

  for(plugin: RegisteredPlugin): PluginContext<unknown> {
    const { name, version, defaultConfig } = plugin.manifest
    const existing = this.contexts.get(name)
    if (existing) return existing

    const { env, execCtx, snapshot } = this.options
    const ctx: PluginContext<unknown> = {
      plugin: { name, version },
      botId: this.options.botId,
      config: snapshot.plugins[name]?.config ?? defaultConfig ?? {},
      logger: createLogger(`plugin:${name}`),
      kv: createScopedKV(env.KV, name),
      db: createScopedDB(env.DB, name),
      api: this.options.api,
      service: <T>(serviceName: string): T => {
        if (!this.services.has(serviceName)) {
          throw new Error(`服务未就绪：${serviceName}（插件 ${name} 需在 depends 中声明）`)
        }
        return this.services.get(serviceName) as T
      },
      waitUntil: (p) => execCtx.waitUntil(p),
    }
    this.contexts.set(name, ctx)
    return ctx
  }

  /** 解析插件声明依赖的服务；提供者缺失、禁用或加载失败时抛出可读错误 */
  async prepare(plugin: RegisteredPlugin): Promise<PluginContext<unknown>> {
    const wanted = Object.keys(plugin.manifest.depends).filter((d) => this.options.registry.providerOf(d))
    await Promise.all(wanted.map((s) => this.resolveService(s)))
    return this.for(plugin)
  }

  private resolveService(serviceName: string): Promise<void> {
    if (this.services.has(serviceName)) return Promise.resolve()
    let task = this.pending.get(serviceName)
    if (task) return task

    task = (async () => {
      const providerName = this.options.registry.providerOf(serviceName)!
      const provider = this.options.registry.get(providerName)!
      if (!(this.options.snapshot.plugins[providerName]?.enabled ?? true)) {
        throw new Error(`服务 ${serviceName} 的提供者 ${providerName} 未启用`)
      }
      const def = await provider.load()
      const factory = def?.services?.[serviceName]
      if (!factory) throw new Error(`插件 ${providerName} 加载失败，服务 ${serviceName} 不可用`)
      this.services.set(serviceName, await factory(this.for(provider)))
    })()
    this.pending.set(serviceName, task)
    return task
  }
}
