import type { EventName } from './events.js'
import type { Keyboard } from './keyboard.js'

/** 会话场景：决定回复走哪个 OpenAPI 端点 */
export type Scene = 'group' | 'c2c' | 'guild' | 'guild_dm' | 'unknown'

export interface Attachment {
  url: string
  contentType?: string
  filename?: string
  width?: number
  height?: number
  size?: number
}

/** 消息里 @ 的一个对象（`mentions` 数组项） */
export interface Mention {
  id: string
  username: string
  /** 平台标记的被 @ 者是否为机器人 */
  bot: boolean
}

export type MediaType = 'image' | 'video' | 'voice' | 'file'

/**
 * 富媒体来源。图片 png/jpg、视频 mp4、语音 silk、文件任意。
 * `url` 由平台拉取；`base64` 直传（原型实测可用，文档已不再列出，大文件请用 url）。
 */
export interface MediaSource {
  type: MediaType
  url?: string
  base64?: string
  filename?: string
}

/** `image` 是 `media: { type: 'image' }` 的简写 */
export interface ImageSource {
  url?: string
  base64?: string
}

export interface Markdown {
  content?: string
  /** 已废弃但仍可用的平台模板 */
  customTemplateId?: string
  params?: Array<{ key: string; values: string[] }>
  /** 图片转存失败时报错而不是静默发送 */
  forceVerifyImage?: boolean
}

/**
 * 出站消息。字符串即纯文本。
 * - `keyboard` 会自动把消息升级为 markdown（平台要求）
 * - `quote` 为 true 时引用当前收到的消息；传字符串则引用指定的 ref index
 */
export type OutgoingMessage =
  | string
  | {
      text?: string
      image?: ImageSource
      media?: MediaSource
      markdown?: Markdown
      keyboard?: Keyboard
      quote?: boolean | string
    }

export interface SendTarget {
  scene: Scene
  id: string
}

export interface SendOptions {
  /** 被动回复所依据的消息 id（与 eventId 互斥） */
  messageId?: string
  /** 被动回复所依据的事件 id（INTERACTION_CREATE / GROUP_ADD_ROBOT / *_MSG_RECEIVE / FRIEND_ADD） */
  eventId?: string
  msgSeq?: number
  /** 互动召回消息（单聊，30 天内有限次数） */
  wakeup?: boolean
}

export interface SendResult {
  ok: boolean
  status: number
  messageId?: string
  /** 供他人引用本条消息的 ref index（ext_info.ref_idx） */
  refIndex?: string
  error?: string
  /** OpenAPI 原始响应体 */
  raw: unknown
}

/** 流式消息写入器（仅单聊） */
export interface StreamWriter {
  /** 追加一段文本并下发 */
  write(chunk: string): Promise<SendResult>
  /** 结束流；可附带最后一段 */
  end(chunk?: string): Promise<SendResult>
  readonly messageId: string | undefined
}

export type InteractionType =
  | 'button' // 11 消息按钮
  | 'menu' // 12 快捷菜单
  | 'feedback' // 13 点赞/点踩
  | 'clear_session' // 14
  | 'story' // 15
  | 'switch_model' // 16
  | 'user_authorize' // 18
  | 'group_authorize' // 19
  | 'group_authorize_status' // 20
  | 'unknown'

/** 交互回调结果：0 成功 · 1 失败 · 2 频繁 · 3 重复 · 4 无权限 · 5 仅管理员 */
export type InteractionCode = 0 | 1 | 2 | 3 | 4 | 5

/** INTERACTION_CREATE 的标准化视图 */
export interface Interaction {
  readonly id: string
  readonly type: InteractionType
  readonly rawType: number
  readonly buttonId: string
  readonly buttonData: string
  readonly featureId: string
  /** 被操作的消息 id（频道按钮 / 反馈） */
  readonly messageId: string
  readonly feedback: 'LIKE' | 'UNLIKE' | undefined
  /** 是否已向平台回应过 */
  readonly acked: boolean
  /**
   * 回应平台（PUT /interactions/{id}）。按钮与菜单必须回应，否则客户端一直转圈；
   * 插件不调用时运行时会在分发结束后自动以 0 回应。
   */
  ack(code?: InteractionCode): Promise<boolean>
}

/**
 * 标准化后的一次事件。所有字段均由运行时注入，插件不构造 Session。
 * `raw` 永远是 QQ 推送的原始 `d`，框架标准化字段不够用时直接读它。
 */
export interface Session {
  readonly botId: string
  /** 机器人昵称（面板保存凭证时从 /users/@me 拉取存快照；未保存过为空串） */
  readonly botName: string
  /** 机器人头像 URL（来源同 botName；未保存过为空串） */
  readonly botAvatar: string
  readonly platform: 'qq'
  readonly event: EventName
  /** QQ 原始事件类型（payload.t） */
  readonly rawType: string
  /** 事件唯一 id（幂等键，也是 event_id 被动回复的依据） */
  readonly id: string
  readonly timestamp: number
  readonly raw: unknown

  readonly scene: Scene
  /** 回复目标：group_openid / user_openid / channel_id */
  readonly targetId: string
  readonly userId: string
  readonly userName: string
  /**
   * 用户头像 CDN 直链（官方规范按 botId + userId 拼接，640 规格；userId 为空时是空串）。
   * 其他尺寸用 `qqAvatar(session.botId, session.userId, 140)`。
   */
  readonly avatarUrl: string
  /**
   * 群角色（仅群聊）：owner 群主 / admin 群管理员 / member 普通成员，来自入站事件的
   * author.member_role；单聊与频道没有此概念，未知值归一化为 undefined。
   */
  readonly memberRole: 'owner' | 'admin' | 'member' | undefined
  /** 被动回复所需的消息 id，非消息事件为 undefined */
  readonly messageId: string | undefined
  /** 当前消息可被引用的 ref index（message_scene.ext 中的 msg_idx） */
  readonly refIndex: string | undefined
  /** 本事件是否允许被动回复（消息 id 或受支持的 event_id 任一即可） */
  readonly canReply: boolean
  /** 去掉 @ 与首尾空白后的正文 */
  readonly content: string
  /** 消息里 @ 的对象（含机器人）；部分事件平台不下发，为空数组 */
  readonly mentions: ReadonlyArray<Mention>
  /**
   * 这条消息是否在呼叫本机器人：单聊/频道私信天然是；@ 消息（at_message）由事件类型判定；
   * 群全量消息看平台在 mentions 上标的 is_you；频道全量消息按 mentions 里的 bot 标记尽力推断。
   * 非消息事件恒为 false。为 true 时命令不带前缀也能触发。
   */
  readonly atMe: boolean
  readonly attachments: readonly Attachment[]
  /** 仅 INTERACTION_CREATE 事件有值 */
  readonly interaction: Interaction | undefined

  /** 被动回复当前事件；msg_seq 由运行时集中分配 */
  reply(message: OutgoingMessage): Promise<SendResult>
  /** 主动发送；不传 target 时发往当前会话 */
  send(message: OutgoingMessage, target?: SendTarget): Promise<SendResult>
  /** 显示"正在输入"（仅单聊，≤60 秒） */
  typing(seconds?: number): Promise<SendResult>
  /** 以流式方式被动回复（仅单聊）；群聊会退化为 end() 时一次性发送 */
  stream(): StreamWriter
  /** 撤回消息；不传 id 则撤回本次会话中最后一条成功发出的消息 */
  recall(messageId?: string): Promise<boolean>
}
