import { CORE_TOOLS_SERVICE } from '@qqbot/sdk'
import type { BotApi, PluginContext, ScopedDB, ScopedKV, ScopedR2, StoredObject, Session, ToolActor } from '@qqbot/sdk'
import { botAdminsOf } from './botAdmins.js'
import { withConfigDefaults } from './configSchema.js'
import { createLogger } from './logger.js'
import { createScopedDurable } from './durable.js'
import { createScopedDB, createScopedKV, createScopedR2 } from './scoped.js'
import type { PluginRegistry, RegisteredPlugin } from './registry.js'
import { isOptionalDependency, providerFor } from './services.js'
import { scopeSql, tablePrefix } from './sqlScope.js'
import type { RuntimeEnv, Snapshot } from './types.js'
import { ToolRegistryHost } from './toolRegistry.js'
import { ensureReady } from './lifecycle.js'

export interface ContextFactoryOptions {
  env: RuntimeEnv
  execCtx: ExecutionContext
  registry: PluginRegistry
  snapshot: Snapshot
  api: BotApi
  botId: string
  /** 见 publicUrl.ts；拿不到时是 undefined */
  publicUrl?: string | undefined
  refreshSnapshot?: () => Promise<Snapshot>
}

/**
 * 一次请求内为各插件构造上下文。
 * `ctx.service()` 是同步的，所以调用处理器前需先 `await prepare(plugin)` 解析其 depends 中的服务。
 */
export class ContextFactory {
  private readonly contexts = new Map<string, PluginContext<unknown>>()
  private readonly services = new Map<string, unknown>()
  private readonly providerServices = new Map<string, Promise<unknown>>()
  private readonly pending = new Map<string, Promise<void>>()
  /** 解析失败的服务及原因：可选依赖吞掉了错误，插件调用 ctx.service() 时再如实报出来 */
  private readonly unavailable = new Map<string, string>()
  private actor?: ToolActor
  readonly tools: ToolRegistryHost

  constructor(private readonly options: ContextFactoryOptions) {
    this.tools = new ToolRegistryHost({
      ...options,
      ...(options.refreshSnapshot
        ? {
            refreshSnapshot: async () => {
              options.snapshot = await options.refreshSnapshot!()
              return options.snapshot
            },
          }
        : {}),
      actor: () => this.actor,
      prepare: plugin => this.prepareToolProvider(plugin),
      service: (plugin, name) => this.resolveProviderService(plugin, name),
    })
  }

  /** 仅由事件分发器调用；插件拿到的 ctx 不暴露身份设置入口。 */
  bindSession(session: Session): void {
    this.actor = {
      userId: session.userId,
      scene: session.scene,
      targetId: session.targetId,
      memberRole: session.memberRole,
      isBotAdmin: session.isBotAdmin,
    }
  }

  private async prepareToolProvider(plugin: RegisteredPlugin) {
    const seen = new Set<string>()
    const visit = async (current: RegisteredPlugin): Promise<void> => {
      if (seen.has(current.manifest.name)) return
      seen.add(current.manifest.name)
      if (this.options.snapshot.plugins[current.manifest.name]?.enabled === false)
        throw new Error(`插件 ${current.manifest.name} 未启用`)
      for (const [name, range] of Object.entries(current.manifest.depends)) {
        if (name === CORE_TOOLS_SERVICE) continue
        try {
          const owner = providerFor(this.options.registry, this.options.snapshot, name)
          const dependency = owner ? this.options.registry.get(owner) : undefined
          if (!dependency) throw new Error(`服务 ${name} 没有提供者`)
          await visit(dependency)
        } catch (error) {
          if (!isOptionalDependency(range)) throw error
        }
      }
      const def = await current.load()
      if (!def) throw new Error(`插件 ${current.manifest.name} 加载失败`)
      await ensureReady(current, def, this.options.env, this, createLogger('tools'), true)
      await this.prepare(current)
    }
    await visit(plugin)
    const def = await plugin.load()
    if (!def) throw new Error(`插件 ${plugin.manifest.name} 加载失败`)
    return { def, ctx: this.for(plugin) }
  }

  for(plugin: RegisteredPlugin): PluginContext<unknown> {
    const { name, version, defaultConfig, configSchema } = plugin.manifest
    const existing = this.contexts.get(name)
    if (existing) return existing

    const { env, execCtx, snapshot } = this.options
    const coreTools = this.tools.for(name)
    const ctx: PluginContext<unknown> = {
      plugin: { name, version },
      botId: this.options.botId,
      ...(this.options.publicUrl ? { publicUrl: this.options.publicUrl } : {}),
      botAdmins: botAdminsOf(snapshot),
      config:
        withConfigDefaults(snapshot.plugins[name]?.config, defaultConfig, configSchema) ??
        defaultConfig ??
        {},
      logger: createLogger(`plugin:${name}`),
      kv: createScopedKV(env.KV, name),
      db: createScopedDB(env.DB, name),
      r2: createScopedR2(env.R2, name),
      ...(env.IMAGES ? { images: env.IMAGES } : {}),
      ...(env.BROWSER ? { browser: env.BROWSER } : {}),
      api: this.options.api,
      durable: createScopedDurable(env, name, plugin.manifest.durableObjects),
      service: <T>(serviceName: string): T => {
        // 只认自己声明过的：服务表是整个请求共用的，不查的话别的插件先解析过，没声明的也能拿到——
        // 能不能用取决于谁先跑，依赖关系也不在清单里
        if (!Object.hasOwn(plugin.manifest.depends ?? {}, serviceName)) {
          throw new Error(`插件 ${name} 没有在 depends 中声明服务 ${serviceName}`)
        }
        if (serviceName === CORE_TOOLS_SERVICE) return coreTools as T
        if (!this.services.has(serviceName)) {
          const reason = this.unavailable.get(serviceName)
          throw new Error(
            reason
              ? `服务 ${serviceName} 不可用：${reason}`
              : `服务 ${serviceName} 没有提供者（插件 ${name}）`,
          )
        }
        return this.services.get(serviceName) as T
      },
      waitUntil: p => execCtx.waitUntil(p),
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
      this.services.set(serviceName, await this.resolveProviderService(provider, serviceName))
    })().catch((err: unknown) => {
      this.unavailable.set(serviceName, err instanceof Error ? err.message : String(err))
      throw err
    })
    this.pending.set(serviceName, task)
    return task
  }

  /** 普通服务与工具绑定共享实例；同名服务的不同提供者各自缓存。 */
  private resolveProviderService(
    provider: RegisteredPlugin,
    serviceName: string,
  ): Promise<unknown> {
    const key = JSON.stringify([provider.manifest.name, serviceName])
    let task = this.providerServices.get(key)
    if (!task) {
      task = (async () => {
        const def = await provider.load()
        const factory = def?.services?.[serviceName]
        if (typeof factory !== 'function') {
          throw new Error(`插件 ${provider.manifest.name} 未提供服务 ${serviceName}`)
        }
        return factory(this.for(provider))
      })()
      this.providerServices.set(key, task)
    }
    return task
  }
}
