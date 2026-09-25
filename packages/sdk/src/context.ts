// 纯类型循环引用（durable.ts 反过来引本文件的 ScopedKV 等）：`import type` 会被完整擦除，
// 不产生运行时依赖，所以不会成环
import type { ScopedDurableObjects } from './durable.js'
import type {
  ImageSource,
  InteractionCode,
  MediaSource,
  OutgoingMessage,
  SendOptions,
  SendResult,
  SendTarget,
} from './session.js'

export type Awaitable<T> = T | Promise<T>

export interface Logger {
  debug(message: string, data?: unknown): void
  info(message: string, data?: unknown): void
  warn(message: string, data?: unknown): void
  error(message: string, data?: unknown): void
}

/** 按插件名自动加前缀的 KV，插件之间互不可见 */
export interface ScopedKV {
  get(key: string): Promise<string | null>
  getJSON<T = unknown>(key: string): Promise<T | null>
  put(key: string, value: string | object, options?: { ttl?: number }): Promise<void>
  delete(key: string): Promise<void>
  list(prefix?: string): Promise<string[]>
}

/** R2 对象的元信息 */
export interface StoredObject {
  /** 已去掉插件前缀 */
  key: string
  size: number
  uploadedAt: Date
  /** 上传时随对象存下的自定义元数据 */
  metadata?: Record<string, string>
}

/**
 * 按插件名加键前缀的 R2，放 KV / D1 不该装的大东西（图片、音频、导出的文件）。
 * KV 单值上限 25 MB 且按值计费，D1 存二进制要先转 base64——都不合适。
 */
export interface ScopedR2 {
  get(key: string): Promise<ArrayBuffer | null>
  getText(key: string): Promise<string | null>
  getJSON<T = unknown>(key: string): Promise<T | null>
  /** 可流式读取的响应体，适合直接回给 HTTP 路由，不必先整个读进内存 */
  getStream(key: string): Promise<ReadableStream | null>
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string | ReadableStream | Blob,
    options?: { contentType?: string; metadata?: Record<string, string> },
  ): Promise<void>
  delete(key: string | string[]): Promise<void>
  head(key: string): Promise<StoredObject | null>
  /** 只列本插件的对象 */
  list(prefix?: string, options?: { limit?: number }): Promise<StoredObject[]>
}

/**
 * 按插件名加表前缀的 D1。SQL 里用 `{表名}` 占位，运行时展开成 `p_<插件名>_表名`：
 *
 * ```ts
 * await ctx.db.exec('CREATE TABLE IF NOT EXISTS {notes} (id TEXT PRIMARY KEY, text TEXT)')
 * await ctx.db.run('INSERT INTO {notes} (id, text) VALUES (?, ?)', id, text)
 * ```
 *
 * 指向别的插件或框架自己的表会直接抛错——这既是防撞名误删，也是**卸载时框架
 * 清得掉你的数据**的前提：表名不带前缀，框架就枚举不出你建过哪些表。
 *
 * 要读别的插件的数据，让对方 `services` 导出方法、你在 `depends` 里声明，
 * 不要直接查它的表：直连是隐形依赖，对方一卸载你就静默坏掉。
 */
export interface ScopedDB {
  /** @deprecated 直接在 SQL 里写 `{表名}` 占位即可，不必手动拼前缀 */
  table(name: string): string
  /** 建表等 DDL，可含多条语句；不接受绑定参数 */
  exec(sql: string): Promise<void>
  run(sql: string, ...params: unknown[]): Promise<{ changes: number }>
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>
  first<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | null>
}

export interface UploadedMedia {
  fileInfo: string
  fileUuid: string
  /** 秒；0 表示长期有效 */
  ttl: number
}

export interface StreamChunkOptions extends SendOptions {
  /** 首片不传；后续片带上首片返回的 messageId */
  streamId?: string
  index: number
  /** 是否为最后一片 */
  final: boolean
  markdown?: boolean
}

// ---------- 群管理（机器人需为群管理员；部分接口平台内邀开放） ----------

export interface GroupMember {
  member_openid: string
  username: string
  member_role: 'member' | 'admin' | 'owner' | string
  bot: boolean
  joined_at: string
  union_openid?: string
}

/** 机器人自身资料（GET /users/@me） */
export interface BotProfile {
  id: string
  username: string
  avatar: string
  /** 平台未完全类型化，其余字段原样保留 */
  [key: string]: unknown
}

/** 群资料（GET /v2/groups/{id}/info）；字段为 2026-09 实测形状，未列出的原样保留 */
export interface GroupInfo {
  group_openid?: string
  group_name?: string
  group_member_num?: number
  group_finger_memo?: string
  group_class_text?: string
  group_tags?: string[]
  [key: string]: unknown
}

/**
 * 入群自动审批策略：命中白名单号码的入群申请自动通过。
 * 一个机器人最多 20 个策略；仅当机器人在关联群拥有管理员身份时策略才会运行。
 * 请求/响应字段为官方文档（2026-09 核对）。
 */
export interface JoinApprovalStrategy {
  strategy_id?: string
  is_enable?: 'on' | 'off' | string
  expire_at?: string
  remark?: string
  group_openids?: string[]
  group_ids?: Array<number | string>
  [key: string]: unknown
}

export interface JoinRequest {
  join_request_id: string
  member_openid: string
  username?: string
  apply_at?: string
  apply_source?: 'self_apply' | 'invited' | string
  invited_by?: string
  bot?: boolean
  risk_tips?: string
  verify_info?: {
    method?: string
    verify_message?: string
    review_qa_list?: Array<{ question: string; answer: string }>
  }
  [key: string]: unknown
}

export type MuteOp =
  | { op: 'add' | 'update'; memberOpenid: string; expireAt: Date | string }
  | { op: 'del'; memberOpenid: string }

export interface GroupApi {
  info(groupOpenid: string): Promise<GroupInfo>
  botState(groupOpenid: string): Promise<Record<string, unknown>>
  /** 查询入群自动审批策略列表（平台标注内邀）；游标分页 */
  joinStrategies(cursor?: string): Promise<{ strategies: JoinApprovalStrategy[]; nextCursor: string }>
  /**
   * 创建入群自动审批策略：`groupOpenids` 与 `groupIds` 二选一必填（互斥，≤100 个）。
   * 不传 `expireAt` 平台默认一年过期；默认启用。返回服务端生成的 `strategyId`。
   */
  createJoinStrategy(input: {
    groupOpenids?: string[]
    groupIds?: Array<number | string>
    isEnable?: 'on' | 'off'
    expireAt?: Date | string
    remark?: string
  }): Promise<{ strategyId: string; isEnable?: string; expireAt?: string }>
  /** 修改策略：启停、过期时间、备注或增删关联群 */
  updateJoinStrategy(
    strategyId: string,
    patch: {
      isEnable?: 'on' | 'off'
      expireAt?: Date | string
      remark?: string
      groupAction?: { op: 'add' | 'del'; groupOpenids?: string[]; groupIds?: Array<number | string> }
    },
  ): Promise<{ isEnable?: string; expireAt?: string }>
  /** 删除策略 */
  deleteJoinStrategy(strategyId: string): Promise<void>
  /** 对策略关联的全部群发起全量扫描（异步，约 10 分钟完成） */
  executeJoinStrategy(strategyId: string): Promise<void>
  /** 批量增删策略的白名单 QQ 号码（单次 ≤10000） */
  updateJoinStrategyWhitelist(
    strategyId: string,
    op: 'add' | 'del',
    qqNumbers: string[],
  ): Promise<{ whitelistUserCount?: number; updatedAt?: string }>
  /** 逐页拉取成员，每页最多 30 */
  members(groupOpenid: string, cursor?: string): Promise<{ members: GroupMember[]; nextCursor: string }>
  member(groupOpenid: string, memberOpenid: string): Promise<GroupMember>
  /** 单次最多 20 人 */
  removeMembers(
    groupOpenid: string,
    memberOpenids: string[],
    options?: { addToBlacklist?: boolean },
  ): Promise<{ failedBlacklist: string[] }>
  blacklist(groupOpenid: string): Promise<Record<string, unknown>>
  updateBlacklist(groupOpenid: string, op: 'add' | 'del', memberOpenids: string[]): Promise<{ failed: string[] }>
  /** 单次最多 20 条；最长 30 天 */
  mute(groupOpenid: string, ops: MuteOp[]): Promise<void>
  muteState(groupOpenid: string): Promise<Record<string, unknown>>
  joinRequests(groupOpenid: string): Promise<JoinRequest[]>
  reviewJoinRequest(
    groupOpenid: string,
    memberOpenid: string,
    decision: { approve: true } | { approve: false; reason?: string; addToBlacklist?: boolean },
    joinRequestId?: string,
  ): Promise<void>
}

/** QQ OpenAPI 访问口。`raw` 永远可用，框架未封装的接口直接调它 */
export interface BotApi {
  raw<T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T }>
  /** 机器人自身资料（GET /users/@me）；调用频率由插件自己控制，框架不做缓存 */
  me(): Promise<BotProfile>
  sendMessage(target: SendTarget, message: OutgoingMessage, options?: SendOptions): Promise<SendResult>
  /** 上传富媒体，返回可放入 media.file_info 的凭证 */
  uploadMedia(target: SendTarget, media: MediaSource | ImageSource): Promise<UploadedMedia>
  /** 单聊"正在输入"状态 */
  typing(userOpenid: string, seconds?: number, options?: SendOptions): Promise<SendResult>
  /** 流式消息单片（仅单聊）；一般用 session.stream() */
  streamChunk(userOpenid: string, content: string, options: StreamChunkOptions): Promise<SendResult>
  /** 撤回 2 分钟内的消息；群管理员可撤回普通成员的消息 */
  recallMessage(target: SendTarget, messageId: string): Promise<boolean>
  /** 回应交互事件（按钮/菜单） */
  ackInteraction(interactionId: string, code?: InteractionCode): Promise<boolean>
  readonly group: GroupApi
}

/**
 * 运行时注入给插件的全部能力。插件不 import 运行时，只用这里的对象。
 * 新增能力优先做成服务（`service()`），而不是往这里加固定字段。
 */
export interface PluginContext<C = unknown> {
  readonly plugin: { readonly name: string; readonly version: string }
  readonly botId: string
  readonly config: C
  readonly logger: Logger
  readonly kv: ScopedKV
  readonly db: ScopedDB
  /** 大文件存储；未绑定 R2 时调用会抛出可读错误 */
  readonly r2: ScopedR2
  readonly api: BotApi
  /** 本插件声明的 Durable Object；未声明该类名或绑定缺失时抛错 */
  readonly durable: ScopedDurableObjects
  /** 取其他插件提供的服务；未提供时抛错 */
  service<T = unknown>(name: string): T
  /** 让后台任务在响应返回后继续执行 */
  waitUntil(promise: Promise<unknown>): void
}
