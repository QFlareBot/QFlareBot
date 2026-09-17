/** QQ Webhook 推送外层结构 */
export interface WebhookPayload {
  op: number
  id?: string
  t?: string
  s?: number
  d?: unknown
}

export const OpCode = {
  Dispatch: 0,
  HttpCallbackAck: 12,
  CallbackVerify: 13,
} as const

/** 消息类事件的 `d`（群聊 / 单聊 / 频道字段合并，按需读取） */
export interface RawMessageEvent {
  id: string
  content?: string
  timestamp?: string
  author?: {
    id?: string
    username?: string
    member_openid?: string
    user_openid?: string
    union_openid?: string
    member_role?: string
    bot?: boolean
  }
  group_openid?: string
  group_id?: string
  channel_id?: string
  guild_id?: string
  attachments?: Array<{
    url?: string
    content_type?: string
    filename?: string
    width?: number
    height?: number
    size?: number
  }>
  mentions?: Array<{ id?: string; username?: string; bot?: boolean }>
  message_scene?: { source?: string; ext?: string[] }
  message_type?: number
  [key: string]: unknown
}

/** 回调验证（op 13）的 `d` */
export interface CallbackVerifyData {
  plain_token: string
  event_ts: string
}

export const MsgType = {
  Text: 0,
  Markdown: 2,
  Ark: 3,
  Embed: 4,
  Media: 7,
} as const

export const FileType = {
  Image: 1,
  Video: 2,
  Voice: 3,
  File: 4,
} as const
