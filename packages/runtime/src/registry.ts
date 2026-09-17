import { extractManifest, type Manifest, type PluginDefinition } from '@qqbot/sdk'
import { createLogger, errorInfo } from './logger.js'
import type { LazyPluginEntry, PluginEntry } from './types.js'

export interface RegisteredPlugin {
  readonly manifest: Manifest
  /** 求值失败时的错误；有值则本插件被跳过 */
  error?: { message: string; stack?: string }
  /** 懒加载定义；每个 isolate 只求值一次 */
  load(): Promise<PluginDefinition<unknown> | null>
}

function isLazyEntry(entry: PluginEntry): entry is LazyPluginEntry {
  return 'manifest' in entry && typeof (entry as LazyPluginEntry).load === 'function'
}

function isDefinition(value: unknown): value is PluginDefinition<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as PluginDefinition).name === 'string'
}

/** 插件注册表：清单立即可用，代码按需加载，单个插件的求值错误不影响其他插件 */
export class PluginRegistry {
  private readonly plugins = new Map<string, RegisteredPlugin>()
  /** 服务名 → 提供者插件名 */
  private readonly serviceProviders = new Map<string, string>()
  private readonly logger = createLogger('registry')

  constructor(entries: PluginEntry[]) {
    for (const entry of entries) this.register(entry)
  }

  private register(entry: PluginEntry): void {
    const manifest = isLazyEntry(entry)
      ? entry.manifest
      : extractManifest(entry, { version: entry.version ?? '0.0.0' })

    if (this.plugins.has(manifest.name)) {
      this.logger.warn('插件名重复，后者被忽略', { name: manifest.name })
      return
    }

    let cached: Promise<PluginDefinition<unknown> | null> | null = null
    const plugin: RegisteredPlugin = {
      manifest,
      load: () => {
        cached ??= this.evaluate(entry, plugin)
        return cached
      },
    }
    this.plugins.set(manifest.name, plugin)
    for (const service of manifest.services) {
      if (this.serviceProviders.has(service)) {
        this.logger.warn('服务名冲突，保留先注册者', { service, ignored: manifest.name })
        continue
      }
      this.serviceProviders.set(service, manifest.name)
    }
  }

  private async evaluate(entry: PluginEntry, plugin: RegisteredPlugin): Promise<PluginDefinition<unknown> | null> {
    try {
      const def = isLazyEntry(entry) ? (await entry.load()).default : entry
      if (!isDefinition(def)) throw new Error('模块默认导出不是 definePlugin(...) 的结果')
      if (def.name !== plugin.manifest.name) {
        throw new Error(`定义中的 name (${def.name}) 与清单 (${plugin.manifest.name}) 不一致`)
      }
      return def
    } catch (err) {
      plugin.error = errorInfo(err)
      this.logger.error('插件加载失败，已跳过', { name: plugin.manifest.name, ...plugin.error })
      return null
    }
  }

  get(name: string): RegisteredPlugin | undefined {
    return this.plugins.get(name)
  }

  all(): RegisteredPlugin[] {
    return [...this.plugins.values()]
  }

  providerOf(service: string): string | undefined {
    return this.serviceProviders.get(service)
  }
}
