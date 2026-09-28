import type { BotApi, PluginContext, ScopedDB, ScopedKV, ScopedR2, StoredObject } from '@qqbot/sdk'
import { withConfigDefaults } from './configSchema.js'
import { createLogger } from './logger.js'
import { createScopedDurable } from './durable.js'
import { createScopedDB, createScopedKV, createScopedR2 } from './scoped.js'
import type { PluginRegistry, RegisteredPlugin } from './registry.js'
import { isOptionalDependency, providerFor } from './services.js'
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
  /** 解析失败的服务及原因：可选依赖吞掉了错误，插件调用 ctx.service() 时再如实报出来 */
  private readonly unavailable = new Map<string, string>()

  constructor(private readonly options: ContextFactoryOptions) {}

  for(plugin: RegisteredPlugin): PluginContext<unknown> {
    const { name, version, defaultConfig, configSchema } = plugin.manifest
    const existing = this.contexts.get(name)
    if (existing) return existing

    const { env, execCtx, snapshot } = this.options
    const ctx: PluginContext<unknown> = {
      plugin: { name, version },
      botId: this.options.botId,
      config: withConfigDefaults(snapshot.plugins[name]?.config, defaultConfig, configSchema) ?? defaultConfig ?? {},
      logger: createLogger(`plugin:${name}`),
      kv: createScopedKV(env.KV, name),
      db: createScopedDB(env.DB, name),
      r2: createScopedR2(env.R2, name),
      api: this.options.api,
      durable: createScopedDurable(env, name, plugin.manifest.durableObjects),
      service: <T>(serviceName: string): T => {
        // 只认自己声明过的：服务表是整个请求共用的，不查的话别的插件先解析过，没声明的也能拿到——
        // 能不能用取决于谁先跑，依赖关系也不在清单里
        if (!Object.hasOwn(plugin.manifest.depends ?? {}, serviceName)) {
          throw new Error(`插件 ${name} 没有在 depends 中声明服务 ${serviceName}`)
        }
        if (!this.services.has(serviceName)) {
          const reason = this.unavailable.get(serviceName)
          throw new Error(reason ? `服务 ${serviceName} 不可用：${reason}` : `服务 ${serviceName} 没有提供者（插件 ${name}）`)
        }
        return this.services.get(serviceName) as T
      },
      waitUntil: (p) => execCtx.waitUntil(p),
    }
    this.contexts.set(name, ctx)
    return ctx
  }

  /**
   * 解析插件声明依赖的服务，连同提供者自己依赖的（服务对象里调 ctx.service() 取它的依赖时，得已经在服务表里；
   * 以前只有提供者带 onBoot / onInstall 钩子时才顺带解析了，链式依赖能不能用全看运气）。
   *
   * 自己的必需依赖停用或加载失败时抛出可读错误；可选依赖、提供者的依赖不抛，调用时 ctx.service() 再如实报。
   * 没有提供者的不在这里报：安装时拦过了，真走到这一步（提供者被卸载）由 ctx.service() 报
   */
  async prepare(plugin: RegisteredPlugin): Promise<PluginContext<unknown>> {
    const depends = plugin.manifest.depends ?? {}
    for (const service of this.closure(Object.keys(depends))) {
      try {
        await this.resolveService(service)
      } catch (err) {
        if (Object.hasOwn(depends, service) && !isOptionalDependency(depends[service])) throw err
      }
    }
    return this.for(plugin)
  }

  /**
   * 这些服务及其提供者（递归）依赖的服务，依赖在前：提供者的工厂里立即取依赖也拿得到。
   * 有环时不会卡住——每个服务只进一次，解析也不等别的服务（resolveService 只加载自己的提供者）
   */
  private closure(services: string[]): string[] {
    const { registry, snapshot } = this.options
    const order: string[] = []
    const seen = new Set<string>()
    const visit = (service: string) => {
      if (seen.has(service)) return
      seen.add(service)
      const provider = providerFor(registry, snapshot, service)
      if (!provider) return
      for (const dep of Object.keys(registry.get(provider)?.manifest.depends ?? {})) visit(dep)
      order.push(service)
    }
    services.forEach(visit)
    return order
  }

  private resolveService(serviceName: string): Promise<void> {
    if (this.services.has(serviceName)) return Promise.resolve()
    let task = this.pending.get(serviceName)
    if (task) return task

    task = (async () => {
      const providerName = providerFor(this.options.registry, this.options.snapshot, serviceName)!
      const provider = this.options.registry.get(providerName)!
      if (!(this.options.snapshot.plugins[providerName]?.enabled ?? true)) {
        throw new Error(`服务 ${serviceName} 的提供者 ${providerName} 未启用`)
      }
      const def = await provider.load()
      const factory = def?.services?.[serviceName]
      if (!factory) throw new Error(`插件 ${providerName} 加载失败，服务 ${serviceName} 不可用`)
      this.services.set(serviceName, await factory(this.for(provider)))
    })().catch((err: unknown) => {
      this.unavailable.set(serviceName, err instanceof Error ? err.message : String(err))
      throw err
    })
    this.pending.set(serviceName, task)
    return task
  }
}
