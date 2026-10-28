/**
 * Durable Object 的作用域装配。
 *
 * 平台构造 DO 时不经过框架，所以作用域不能像 `ctx` 那样在分发时现装——只能预先挂到类上：
 * 投影生成的入口用 `durableScope()` 给每个 DO 类打上工厂，`PluginDurableObject` 的构造器
 * 取来把裸 env 换成本插件的作用域上下文再交给平台基类。
 *
 * 结果是插件在 DO 里拿到的 `this.plugin.kv / .db / .r2` 与处理器里的 `ctx.kv / .db / .r2`
 * 前缀完全一致，卸载时按前缀清理才清得干净。
 */
import { QQBotClient } from '@qqbot/api'
import { doExportName } from '@qqbot/projector'
import { PLUGIN_SCOPE, type BotApi, type DurableContext, type ScopedDurableObjectClass, type ScopedDurableObjects } from '@qqbot/sdk'
import { createScopedDB, createScopedKV, createScopedR2 } from './scoped.js'
import { createLogger } from './logger.js'
import { refIndexes } from './refIndex.js'
import { kvTokenCache, readBotConfig } from './store.js'
import { unavailableApi } from './unavailableApi.js'
import type { RuntimeEnv } from './types.js'

/** 给 DO 类挂上作用域工厂并原样返回；投影入口在重导出时调用 */
export function durableScope<T>(Impl: T, pluginName: string): T {
  ;(Impl as ScopedDurableObjectClass)[PLUGIN_SCOPE] = (env) => createDurableContext(env as RuntimeEnv, pluginName)
  return Impl
}

/**
 * DO 里可用的作用域上下文。
 *
 * 没有 `config`：它要读面板快照，而 DO 的构造器是同步的，等不了。
 * `api` 用**惰性初始化**解决同一个问题——构造时什么都不读，首次调用某个方法时
 * 才去读凭证并建客户端。这样 DO 里跑完 agent 能直接发消息，不必绕回 Worker。
 *
 * `options.fetchImpl` 只给测试用：DO 由平台构造、拿不到 `RuntimeOptions`，
 * 线上走全局 fetch；测试里注入替身，不必 stub 全局。
 */
export function createDurableContext(
  env: RuntimeEnv,
  pluginName: string,
  options: { fetchImpl?: typeof fetch } = {},
): DurableContext {
  return {
    plugin: { name: pluginName },
    logger: createLogger(`durable:${pluginName}`),
    kv: createScopedKV(env.KV, pluginName),
    db: createScopedDB(env.DB, pluginName),
    r2: createScopedR2(env.R2, pluginName),
    api: lazyBotApi(env, options.fetchImpl),
  }
}

/**
 * 惰性 QQ API 客户端。
 *
 * 为什么不能同步建：`readBotConfig()` 要读 KV（面板保存的凭证）或 Worker Secret，
 * 是异步的，而 `DurableContext` 在 `PluginDurableObject` 的构造器里同步装配。
 *
 * 为什么用 Proxy 而不是返回 Promise：`ctx.api` 的用法是 `await api.sendMessage(...)`，
 * 直接给 Promise 会变成 `await (await p).sendMessage` —— 插件侧写法全要改。
 * Proxy 让每个方法调用返回 Promise，用法与 `ctx.api` 完全一致。
 *
 * `group` 是属性（`GroupApi`）不是方法，单独处理：拿到时先返回一个占位代理，
 * 等它上面的方法被调用时再转发。这样 `api.group.mute(...)` 也能用。
 */
function lazyBotApi(env: RuntimeEnv, fetchImpl?: typeof fetch): BotApi {
  let clientPromise: Promise<BotApi> | null = null

  const ensure = (): Promise<BotApi> => {
    // 并发首次调用只读一次凭证
    clientPromise ??= buildBotApi(env, fetchImpl).catch((error: unknown) => {
      // 建失败不缓存，下次重试——否则一次 KV 抖动会让这个 DO 实例永远拿不到 api
      clientPromise = null
      throw error
    })
    return clientPromise
  }

  // 每个方法都转发到真实 client；`group` 走另一个代理
  const methodProxy = (prefix: string[]): unknown =>
    new Proxy(() => {}, {
      get: (_target, prop) => {
        if (prop === 'then') return undefined // 别让 await 把代理当 thenable
        return methodProxy([...prefix, String(prop)])
      },
      apply: async (_target, _thisArg, args: unknown[]) => {
        const client = await ensure()
        // 沿 prefix 逐层取到真实对象，再调用
        let target: unknown = client
        for (const key of prefix.slice(0, -1)) {
          target = (target as Record<string, unknown>)[key]
        }
        const fn = (target as Record<string, unknown>)[prefix.at(-1) ?? ''] as
          | ((...a: unknown[]) => unknown)
          | undefined
        if (typeof fn !== 'function') {
          throw new Error(`ctx.api 上没有 ${prefix.join('.')} 这个方法`)
        }
        return fn.apply(target, args)
      },
    })

  return new Proxy({} as BotApi, {
    get: (_target, prop) => {
      if (prop === 'then') return undefined
      if (prop === 'appId') {
        // 同步字段：没配置时给空串，避免插件读它就炸
        return env.BOT_APPID ?? ''
      }
      return methodProxy([String(prop)])
    },
  })
}

/** 真正建客户端。凭证读取与 Worker 侧共用同一个缓存，所以换号后行为一致 */
async function buildBotApi(env: RuntimeEnv, fetchImpl?: typeof fetch): Promise<BotApi> {
  const bot = await readBotConfig(env)
  if (!bot) return unavailableApi()

  return new QQBotClient({
    appId: bot.appId,
    secret: bot.secret,
    tokenCache: kvTokenCache(env, bot.appId),
    ...(fetchImpl ? { fetchImpl } : {}),
    // 与 Worker 侧同一张对照表：DO 里发出的消息也要能被引用/撤回
    onSent: (target, result) => refIndexes.rememberSent(target, result),
  })
}

/**
 * `ctx.durable`：只给得到本插件声明过的类。
 *
 * 两处都抛可读错误而不是返回 undefined——拿到 undefined 之后炸在 `.get` 上，
 * 报的是 "Cannot read properties of undefined"，查起来跟这里的真实原因差着十万八千里。
 */
export function createScopedDurable(
  env: RuntimeEnv,
  pluginName: string,
  declared: readonly string[],
): ScopedDurableObjects {
  const namespaceOf = (className: string): DurableObjectNamespace => {
    if (!declared.includes(className)) {
      throw new Error(
        `插件 ${pluginName} 没有声明 Durable Object 类 ${className}` +
          `（已声明：${declared.length ? declared.join('、') : '无'}）——只能取自己 durableObjects 里的类`,
      )
    }
    const binding = (env as unknown as Record<string, unknown>)[doExportName(pluginName, className)]
    if (!binding) {
      throw new Error(
        `Durable Object 绑定 ${doExportName(pluginName, className)} 不存在：` +
          '多半是这次部署还没带上它（改了 migrations 之后需要重新构建并切流量）',
      )
    }
    return binding as DurableObjectNamespace
  }

  return {
    get: (className, instanceName) => {
      const ns = namespaceOf(className)
      // 命名空间本身已经是「插件 + 类」粒度，实例名不必再加前缀，跨插件撞不上
      return ns.get(ns.idFromName(instanceName)) as never
    },
    namespace: (className) => namespaceOf(className) as never,
  }
}
