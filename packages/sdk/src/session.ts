import type { EventName } from './events.js'

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

/** 图片来源：URL 或 base64，二选一 */
export interface ImageSource {
  url?: string
  base64?: string
}

/** 出站消息：字符串即纯文本；对象可组合文本、图片、markdown */
export type OutgoingMessage =
  | string
  | {
      text?: string
      image?: ImageSource
      markdown?: Record<string, unknown>
      keyboard?: Record<string, unknown>
    }

export interface SendTarget {
  scene: Scene
  id: string
}

export interface SendResult {
  ok: boolean
  status: number
  messageId?: string
  error?: string
  /** OpenAPI 原始响应体 */
  raw: unknown
}

/**
 * 标准化后的一次事件。所有字段均由运行时注入，插件不构造 Session。
 * `raw` 永远是 QQ 推送的原始 `d`，框架标准化字段不够用时直接读它。
 */
export interface Session {
  readonly botId: string
  readonly platform: 'qq'
  readonly event: EventName
  /** QQ 原始事件类型（payload.t） */
  readonly rawType: string
  /** 事件唯一 id（幂等键） */
  readonly id: string
  readonly timestamp: number
  readonly raw: unknown

  readonly scene: Scene
  /** 回复目标：group_openid / user_openid / channel_id */
  readonly targetId: string
  readonly userId: string
  readonly userName: string
  /** 被动回复所需的消息 id，非消息事件为 undefined */
  readonly messageId: string | undefined
  /** 去掉 @ 与首尾空白后的正文 */
  readonly content: string
  readonly attachments: readonly Attachment[]

  /** 被动回复当前消息；msg_seq 由运行时集中分配 */
  reply(message: OutgoingMessage): Promise<SendResult>
  /** 主动发送；不传 target 时发往当前会话 */
  send(message: OutgoingMessage, target?: SendTarget): Promise<SendResult>
}
