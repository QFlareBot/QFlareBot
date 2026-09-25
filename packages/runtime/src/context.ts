import type { BotApi, PluginContext, ScopedDB, ScopedKV, ScopedR2, StoredObject } from '@qqbot/sdk'
import { createLogger } from './logger.js'
import { createScopedDurable } from './durable.js'
import { createScopedDB, createScopedKV, createScopedR2 } from './scoped.js'
import type { PluginRegistry, RegisteredPlugin } from './registry.js'
import { scopeSql, tablePrefix } from './sqlScope.js'
import type { RuntimeEnv, Snapshot } from './types.js'

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
      r2: createScopedR2(env.R2, name),
      api: this.options.api,
      durable: createScopedDurable(env, name, plugin.manifest.durableObjects),
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
