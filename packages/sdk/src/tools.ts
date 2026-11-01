import type { Awaitable, PluginContext } from './context.js'
import type { JsonSchema, PermissionTier } from './plugin.js'
import type { Scene, Session } from './session.js'

/** 框架保留的服务，不参与普通插件的同名提供者选择。 */
export const CORE_TOOLS_SERVICE = 'core.tools' as const
export const TOOL_CONTRACT_VERSION = 1 as const

export type PluginToolEffect = 'none' | 'workspace_write' | 'external_write' | 'dangerous'

export interface PluginToolSpec {
  description: string
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
  permission: PermissionTier
  sideEffect: PluginToolEffect
  /** 工具协议版本。行为或参数不兼容时递增；提供者版本也会参与 revision。 */
  version?: number
  timeoutMs?: number
  scenes?: Scene[]
}

export interface PluginToolDescriptor extends PluginToolSpec {
  id: string
  owner: string
  name: string
  /** 清单内容与提供者版本的摘要，invoke 必须带上，避免恢复时切换实现。 */
  revision: string
  timeoutMs: number
}

/** 可以存入队列/检查点；仅在框架签发的用户、会话、调用插件及有效期内可用。不要发给模型。 */
export interface ToolInvocation {
  token: string
}

export type ToolActor = Pick<Session, 'userId' | 'scene' | 'targetId' | 'memberRole' | 'isBotAdmin'>

export interface PluginToolArtifact {
  type: 'image' | 'file' | 'voice' | 'video'
  url?: string
  base64?: string
  filename?: string
  caption?: string
}

export interface PluginToolResult {
  status: 'success' | 'failed' | 'permission_denied' | 'cancelled' | 'timeout' | 'unknown'
  output?: unknown
  artifacts?: PluginToolArtifact[]
  error?: { code: string; message: string; retryable: boolean }
}

export interface PluginToolInput<C = unknown> {
  /** 提供者自己的上下文。 */
  ctx: PluginContext<C>
  input: unknown
  actor: Readonly<ToolActor>
  caller: Readonly<{ plugin: string; botId: string }>
  callId: string
  /** 同一逻辑调用在恢复后保持一致；提供者可以用它实现幂等。 */
  idempotencyKey: string
  signal: AbortSignal
  deadline: number
}

/** 没有现成服务时，直接实现能力。 */
export interface PluginHandlerTool<C = unknown> extends PluginToolSpec {
  handler(input: PluginToolInput<C>): Awaitable<PluginToolResult>
  service?: never
  method?: never
  mapInput?: never
  mapOutput?: never
}

/** 显式公开本插件的某个服务方法；不枚举、更不推断其他方法的用途。 */
export interface PluginServiceTool<C = unknown> extends PluginToolSpec {
  service: string
  method: string
  /** 默认将模型的 JSON 对象作为唯一参数；旧方法需要位置参数时在此转换。 */
  mapInput?(call: PluginToolInput<C>): Awaitable<readonly unknown[]>
  /** 必须显式解释旧返回值，避免把 { ok: false } 等业务失败误报成成功。 */
  mapOutput(result: unknown): Awaitable<PluginToolResult>
  handler?: never
}

export type PluginTool<C = unknown> = PluginHandlerTool<C> | PluginServiceTool<C>

/** 清单包含绑定目标，但不包含参数/结果转换函数。 */
export interface PluginToolManifest extends PluginToolSpec {
  name: string
  service?: string
  method?: string
}

export function pluginToolMetadata<C>(name: string, tool: PluginTool<C>): PluginToolManifest {
  const { handler: _handler, mapInput: _input, mapOutput: _output, ...spec } = tool
  return { name, ...spec }
}

export interface PluginToolCallOptions {
  invocation: ToolInvocation
  callId: string
  expectedRevision: string
  signal?: AbortSignal
  deadline?: number
}

export interface PluginToolRegistry {
  readonly contractVersion: 1
  /** 从当前真实事件签发有效期 24 小时的上下文；cron/HTTP 不会凭空获得用户身份。 */
  capture(): Promise<ToolInvocation>
  /** 不传 invocation 时只看目录，不能据此执行；传入则按发起人和会话过滤。 */
  list(invocation?: ToolInvocation): Promise<PluginToolDescriptor[]>
  describe(id: string, invocation?: ToolInvocation): Promise<PluginToolDescriptor | null>
  invoke(id: string, input: unknown, options: PluginToolCallOptions): Promise<PluginToolResult>
}

/** 管理员配置的调用约束；空 allow 表示全部禁止，省略表示不限。 */
export interface PluginToolPolicy {
  disabled?: string[]
  consumers?: Record<string, { enabled?: boolean; allow?: string[]; deny?: string[] }>
}
