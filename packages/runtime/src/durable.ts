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
import { doExportName } from '@qqbot/projector'
import { PLUGIN_SCOPE, type DurableContext, type ScopedDurableObjectClass, type ScopedDurableObjects } from '@qqbot/sdk'
import { createScopedDB, createScopedKV, createScopedR2 } from './scoped.js'
import { createLogger } from './logger.js'
import type { RuntimeEnv } from './types.js'

/** 给 DO 类挂上作用域工厂并原样返回；投影入口在重导出时调用 */
export function durableScope<T>(Impl: T, pluginName: string): T {
  ;(Impl as ScopedDurableObjectClass)[PLUGIN_SCOPE] = (env) => createDurableContext(env as RuntimeEnv, pluginName)
  return Impl
}

/** DO 里可用的作用域上下文。没有 api / config：两者都要读快照，同步构造器等不了 */
export function createDurableContext(env: RuntimeEnv, pluginName: string): DurableContext {
  return {
    plugin: { name: pluginName },
    logger: createLogger(`durable:${pluginName}`),
    kv: createScopedKV(env.KV, pluginName),
    db: createScopedDB(env.DB, pluginName),
    r2: createScopedR2(env.R2, pluginName),
  }
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
