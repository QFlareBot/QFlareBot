import type { Logger, PluginDefinition } from '@qqbot/sdk'
import type { ContextFactory } from './context.js'
import { errorInfo } from './logger.js'
import type { RegisteredPlugin } from './registry.js'
import { Keys } from './store.js'
import type { RuntimeEnv } from './types.js'

// isolate 内已执行过 onBoot / 已确认安装的插件，避免每个请求重复检查
const booted = new Set<string>()
const installed = new Set<string>()

/**
 * 首次触及插件时执行生命周期钩子：
 * onInstall 以 KV 标记保证跨部署只跑一次（幂等由插件保证），onBoot 每个 isolate 一次。
 */
export async function ensureReady(
  plugin: RegisteredPlugin,
  def: PluginDefinition<unknown>,
  env: RuntimeEnv,
  contexts: ContextFactory,
  logger: Logger,
): Promise<void> {
  const { name, version } = plugin.manifest

  if (!installed.has(name) && def.hooks?.onInstall) {
    const marker = Keys.installed(name)
    const seen = await env.KV.get(marker)
    if (!seen) {
      try {
        await def.hooks.onInstall(await contexts.prepare(plugin))
        await env.KV.put(marker, version)
        logger.info('插件初始化完成', { plugin: name, version })
      } catch (err) {
        logger.error('插件 onInstall 失败', { plugin: name, ...errorInfo(err) })
      }
    }
    installed.add(name)
  }

  if (!booted.has(name)) {
    booted.add(name)
    if (def.hooks?.onBoot) {
      try {
        await def.hooks.onBoot(await contexts.prepare(plugin))
      } catch (err) {
        logger.error('插件 onBoot 失败', { plugin: name, ...errorInfo(err) })
      }
    }
  }
}

/** 测试用 */
export function resetLifecycle(): void {
  booted.clear()
  installed.clear()
}
