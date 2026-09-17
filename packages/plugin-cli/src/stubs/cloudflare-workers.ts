/**
 * Node 下抽取清单时替代 `cloudflare:workers`。
 * 只需让插件模块顶层能求值（如 `class X extends DurableObject {}`），不提供任何运行时行为。
 */

export class DurableObject {}

export class WorkerEntrypoint {}

export class RpcTarget {}

export const env: Record<string, unknown> = {}

export function waitUntil(_promise: Promise<unknown>): void {}
