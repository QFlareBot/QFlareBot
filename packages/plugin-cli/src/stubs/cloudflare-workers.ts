/**
 * Node 下替代 `cloudflare:workers`：抽取清单时让插件模块顶层能求值
 * （如 `class X extends PluginDurableObject {}`），单测里也用它。
 *
 * 只复刻构造契约，不提供任何运行时行为。`DurableObject` 必须照平台的样子把两个参数
 * 存成 `this.ctx` / `this.env`——`PluginDurableObject` 正是靠 `super(state, scope(env))`
 * 把裸 env 换掉的，基类不赋值的话整套作用域机制在 Node 下根本验不了。
 */

export class DurableObject<Env = unknown> {
  constructor(
    readonly ctx: unknown,
    readonly env: Env,
  ) {}
}

export class WorkerEntrypoint<Env = unknown> {
  constructor(
    readonly ctx: unknown,
    readonly env: Env,
  ) {}
}

export class RpcTarget {}

export const env: Record<string, unknown> = {}

export function waitUntil(_promise: Promise<unknown>): void {}
