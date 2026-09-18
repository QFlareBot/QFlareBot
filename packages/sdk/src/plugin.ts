import type { EventName } from './events.js'
import type { Interaction, InteractionCode, OutgoingMessage, Scene, Session } from './session.js'
import type { Awaitable, PluginContext } from './context.js'

/** 当前契约版本；契约破坏性变更时递增，旧版本由独立的 compat 包适配 */
export const API_VERSION = 1 as const

/** 声明式权限：同 isolate 下不是强制隔离，用于安装时知情同意与审核 */
export type Permission = 'net' | 'proactive' | 'kv' | 'db' | 'durable' | 'admin' | 'group_manage' | 'recall'

export type JsonSchema = Record<string, unknown>

/** 所有匹配器共享的调度字段 */
export interface MatchOptions {
  /** 数值越大越先执行，默认 0 */
  priority?: number
  /** 命中后是否阻止后续匹配器，命令默认 true，其余默认 false */
  block?: boolean
  /** 只在这些场景生效，默认全部 */
  scenes?: Scene[]
}

// ---------- 输入对象：所有处理器只接收一个对象参数，便于向前兼容 ----------

export interface CommandInput<C = unknown> {
  session: Session
  ctx: PluginContext<C>
  /** 实际命中的命令名或别名 */
  command: string
  args: string[]
  /** 命令名之后的原始文本 */
  argText: string
}

export interface RegexInput<C = unknown> {
  session: Session
  ctx: PluginContext<C>
  match: RegExpMatchArray
}

export interface EventInput<C = unknown> {
  session: Session
  ctx: PluginContext<C>
}

export interface ButtonInput<C = unknown> {
  session: Session
  ctx: PluginContext<C>
  interaction: Interaction
  /** 命中的按键 id */
  buttonId: string
  buttonData: string
}

export interface MiddlewareInput<C = unknown> {
  session: Session
  ctx: PluginContext<C>
}

export interface CronInput<C = unknown> {
  ctx: PluginContext<C>
  job: string
  scheduledAt: number
}

export interface RouteInput<C = unknown> {
  ctx: PluginContext<C>
  request: Request
  /** `:name` 段与 `*` 通配（键为 `*`）的取值 */
  params: Record<string, string>
  /** 请求是否带有效的面板登录态或本插件的桥接 token */
  authenticated: boolean
}

// ---------- 处理器返回值：返回什么就回复什么 ----------

/**
 * 处理器可以直接返回回复内容：字符串或消息对象 → 一条 `session.reply()`；
 * （异步）可迭代对象 → 逐条回复，生成器 `yield` 多条即可。当前事件不可被动回复时改用 `send`。
 * 返回 undefined 表示自己已处理完，不再回复。
 */
export type Reply = OutgoingMessage
export type HandlerResult = void | Reply | Iterable<Reply> | AsyncIterable<Reply>

export type CommandHandler<C = unknown> = (input: CommandInput<C>) => Awaitable<HandlerResult>
export type RegexHandler<C = unknown> = (input: RegexInput<C>) => Awaitable<HandlerResult>
export type EventHandler<C = unknown> = (input: EventInput<C>) => Awaitable<HandlerResult>
/** 返回数字即回应平台的 code（0 成功 · 4 无权限 …）；返回消息则回复并自动以 0 回应 */
export type ButtonHandler<C = unknown> = (input: ButtonInput<C>) => Awaitable<HandlerResult | InteractionCode | number>
export type CronHandler<C = unknown> = (input: CronInput<C>) => Awaitable<void>

// ---------- 匹配器定义：每种都可以直接给函数，需要元数据时再用对象 ----------

export interface CommandSpec extends MatchOptions {
  description?: string
  usage?: string
  aliases?: string[]
}

export type Command<C = unknown> = CommandHandler<C> | (CommandSpec & { handler: CommandHandler<C> })

export interface RegexSpec extends MatchOptions {
  pattern: string
  flags?: string
}

export type RegexRule<C = unknown> = RegexSpec & { handler: RegexHandler<C> }
/** 以模式为键：`{ '^ping$': fn }` 或带 flags 的 `{ '/^ping$/i': fn }` */
export type RegexMap<C = unknown> = Record<string, RegexHandler<C> | (Omit<RegexSpec, 'pattern' | 'flags'> & { handler: RegexHandler<C> })>

export interface EventSpec extends Pick<MatchOptions, 'priority' | 'block'> {
  event: EventName | EventName[]
}

export type EventRule<C = unknown> = EventSpec & { handler: EventHandler<C> }
/** 以事件名为键：`{ 'qq.group.robot_added': fn }` */
export type EventMap<C = unknown> = { [E in EventName]?: EventHandler<C> | (Pick<MatchOptions, 'priority' | 'block'> & { handler: EventHandler<C> }) }

export interface ButtonSpec extends Pick<MatchOptions, 'priority' | 'block' | 'scenes'> {
  /** 按 button_data 匹配的正则；不填则只按 key（按键 id）匹配 */
  dataPattern?: string
}

export type ButtonRule<C = unknown> = ButtonHandler<C> | (ButtonSpec & { handler: ButtonHandler<C> })

export interface CronSpec {
  name: string
  /** 标准 5 段 cron，由运行时统一的 Cron Trigger 分发 */
  cron: string
}

export type CronJob<C = unknown> = CronSpec & { handler: CronHandler<C> }
/** 以任务名为键：`{ daily: { cron: '0 9 * * *', handler } }` */
export type CronMap<C = unknown> = Record<string, Omit<CronSpec, 'name'> & { handler: CronHandler<C> }>

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface RouteSpec {
  method: HttpMethod
  /** 相对路径，运行时挂载到 `/p/<插件名>/` 下；支持 `:param` 与末尾 `*` */
  path: string
  /** `admin`：要求面板登录态或本插件的桥接 token，未通过直接 401；默认 public */
  auth?: 'public' | 'admin'
}

/** 插件自带的页面：面板以 iframe 打开 `/p/<插件名><path>`，页面用 @qqbot/ui-bridge 与面板通信 */
export interface PluginUiSpec {
  /** 相对插件路由根的路径，如 `/ui/` */
  path: string
  title?: string
  /** lucide 图标名 */
  icon?: string
}

export interface Route<C = unknown> extends RouteSpec {
  handler(input: RouteInput<C>): Awaitable<Response>
}

export type Middleware<C = unknown> = (
  input: MiddlewareInput<C>,
  next: () => Promise<void>,
) => Awaitable<void>

export interface Hooks<C = unknown> {
  /** 每次 isolate 冷启动，只做轻量初始化 */
  onBoot?(ctx: PluginContext<C>): Awaitable<void>
  /** 首次安装后第一次运行（建表等，需幂等） */
  onInstall?(ctx: PluginContext<C>): Awaitable<void>
  onEnable?(ctx: PluginContext<C>): Awaitable<void>
  onDisable?(ctx: PluginContext<C>): Awaitable<void>
  /** 卸载前在旧版本中执行，可选清理数据 */
  onUninstall?(ctx: PluginContext<C>, options: { purgeData: boolean }): Awaitable<void>
}

// ---------- 插件定义 ----------

export interface PluginDefinition<C = unknown> {
  /** 唯一标识，建议与 npm 包名（去 scope）一致 */
  name: string
  /** 构建时由 package.json 补齐 */
  version?: string
  apiVersion?: typeof API_VERSION
  displayName?: string
  description?: string
  permissions?: Permission[]
  /** JSON Schema，面板据此渲染配置表单 */
  configSchema?: JsonSchema
  defaultConfig?: C
  /** 依赖的服务或插件及其版本范围 */
  depends?: Record<string, string>
  conflicts?: string[]
  /** 兼容的运行时版本范围 */
  coreRange?: string

  commands?: Record<string, Command<C>>
  regex?: RegexRule<C>[] | RegexMap<C>
  events?: EventRule<C>[] | EventMap<C>
  /** 回调按键（action.type = 1）；key 为发送时设置的按键 id */
  buttons?: Record<string, ButtonRule<C>>
  cron?: CronJob<C>[] | CronMap<C>
  routes?: Route<C>[]
  ui?: PluginUiSpec
  middleware?: Middleware<C>
  hooks?: Hooks<C>
  /** 向其他插件提供服务；key 为服务名 */
  services?: Record<string, (ctx: PluginContext<C>) => unknown>
  /** 自带的 Durable Object 类；投影时加前缀重导出并注册 */
  durableObjects?: Record<string, unknown>
}

/** 处理器参数是逆变的，收集不同 Config 的插件时用这个类型 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPluginDefinition = PluginDefinition<any>

/** 恒等函数，只为类型推导与将来的构建期识别 */
export function definePlugin<C = unknown>(definition: PluginDefinition<C>): PluginDefinition<C> {
  return definition
}
