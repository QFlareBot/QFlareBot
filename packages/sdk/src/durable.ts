/**
 * Durable Object 契约。
 *
 * DO 类不由框架实例化——平台直接 `new Room(state, env)`，绕过整条 `PluginContext` 装配。
 * 裸 env 里既有全部 secret，也有**未加前缀**的 KV / D1 / R2，第 6 节那套「前缀即所有权」
 * 在里面完全失效：DO 里建的表框架不知道，卸载时清不掉，永远是孤儿。
 *
 * 所以插件的 DO 类必须继承 `PluginDurableObject`：投影生成的入口在重导出时把一个
 * **作用域工厂**挂成类的静态属性，基类构造时取来把 env 换成本插件的作用域上下文，
 * 再交给平台基类。裸 env 到不了插件手里，而 `this.ctx`（DurableObjectState）与 RPC
 * 方法调用都原样可用。
 */
import type { Logger, ScopedDB, ScopedKV, ScopedR2 } from './context.js'

/**
 * 作用域工厂挂在类上的键。
 *
 * 用 `Symbol.for` 而不是模块级 symbol：SDK 在插件产物与运行时产物里各被打包一份，
 * 模块级 symbol 两边不是同一个值，跨产物读不到。全局注册表里的才通得过。
 */
export const PLUGIN_SCOPE = Symbol.for('qqbot.durable.scope')

/**
 * 基类标记，`qqbot-plugin build` 用它判断 DO 类有没有继承 `PluginDurableObject`。
 *
 * 不能用 `instanceof`：插件产物把 SDK 打包进去了一份，plugin-cli 自己也打包了一份，
 * 两边的 `PluginDurableObject` 是两个不同的类对象。静态属性沿原型链继承，
 * 配上全局 symbol 才跨得过这道边界。
 */
export const PLUGIN_DURABLE_BASE = Symbol.for('qqbot.durable.base')

/** DO 里可用的插件上下文。与 `PluginContext` 的存储三件套同源，前缀隔离一致 */
export interface DurableContext {
  readonly plugin: { readonly name: string }
  readonly logger: Logger
  readonly kv: ScopedKV
  readonly db: ScopedDB
  /** 未绑定 R2 时调用会抛出可读错误 */
  readonly r2: ScopedR2
}

/** 由运行时实现、投影入口注入：把平台给的裸 env 换成本插件的作用域上下文 */
export type DurableScopeFactory = (env: unknown) => DurableContext

/** 带作用域工厂的 DO 类（投影入口挂上去的形态） */
export interface ScopedDurableObjectClass {
  [PLUGIN_SCOPE]?: DurableScopeFactory
}

/** `ctx.durable`：取本插件声明的 Durable Object */
export interface ScopedDurableObjects {
  /**
   * 按名字取实例（`idFromName`）。一个群 / 一个用户 / 一局游戏一个实例，覆盖绝大多数用法。
   *
   * 泛型给上 DO 类就能拿到 RPC 方法的类型：`ctx.durable.get<Room>('Room', groupId)`。
   */
  get<T extends Rpc.DurableObjectBranded | undefined = undefined>(
    className: string,
    instanceName: string,
  ): DurableObjectStub<T>
  /** 需要 `newUniqueId` / `idFromString` 时才用得上的原始命名空间 */
  namespace<T extends Rpc.DurableObjectBranded | undefined = undefined>(className: string): DurableObjectNamespace<T>
}
