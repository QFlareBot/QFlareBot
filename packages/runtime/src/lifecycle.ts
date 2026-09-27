import type { Logger, PluginDefinition } from '@qqbot/sdk'
import type { ContextFactory } from './context.js'
import { errorInfo } from './logger.js'
import type { RegisteredPlugin } from './registry.js'
import { Keys } from './store.js'
import type { RuntimeEnv } from './types.js'

/**
 * isolate 内每个插件的就绪过程，按插件名存一个 Promise，并发请求都 await 同一个。
 * 以前是「开始跑就记下」：onBoot 还没跑完，并发进来的请求就已经进了处理器；onInstall 也会被并发请求各跑一遍
 */
const ready = new Map<string, Promise<void>>()

/**
 * 首次触及插件时执行生命周期钩子：
 * onInstall 以 KV 标记保证跨部署只跑一次（幂等由插件保证），onBoot 每个 isolate 一次。
 * 钩子抛错只记日志、本 isolate 不再重试；读 KV 标记失败才会让这次就绪失败，下个请求重来。
 */
export function ensureReady(
  plugin: RegisteredPlugin,
  def: PluginDefinition<unknown>,
  env: RuntimeEnv,
  contexts: ContextFactory,
  logger: Logger,
): Promise<void> {
  const { name } = plugin.manifest
  let task = ready.get(name)
  if (!task) {
    task = runHooks(plugin, def, env, contexts, logger).catch((err: unknown) => {
      ready.delete(name)
      throw err
    })
    ready.set(name, task)
  }
  return task
}

async function runHooks(
  plugin: RegisteredPlugin,
  def: PluginDefinition<unknown>,
  env: RuntimeEnv,
  contexts: ContextFactory,
  logger: Logger,
): Promise<void> {
  const { name, version } = plugin.manifest

  if (def.hooks?.onInstall) {
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
  }

  if (def.hooks?.onBoot) {
    try {
      await def.hooks.onBoot(await contexts.prepare(plugin))
    } catch (err) {
      logger.error('插件 onBoot 失败', { plugin: name, ...errorInfo(err) })
    }
  }
}

/** 测试用 */
export function resetLifecycle(): void {
  ready.clear()
}
