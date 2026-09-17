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
  /** ext 形如 ["msg_idx=REFIDX_...", "auth_token=..."] */
  message_scene?: { source?: string; ext?: string[] }
  message_type?: number
  [key: string]: unknown
}

/** INTERACTION_CREATE 的 `d` */
export interface RawInteractionEvent {
  id: string
  application_id?: string
  type?: number
  scene?: 'c2c' | 'group' | 'guild' | string
  chat_type?: number
  timestamp?: string
  guild_id?: string
  channel_id?: string
  user_openid?: string
  group_openid?: string
  group_member_openid?: string
  version?: number
  data?: {
    type?: number
    resolved?: {
      button_data?: string
      button_id?: string
      user_id?: string
      feature_id?: string
      message_id?: string
      feedback_opt?: 'LIKE' | 'UNLIKE' | string
      checked?: number
      action?: string
      authorize_data?: { opt_scene?: string; scope?: string }
      [key: string]: unknown
    }
  }
  [key: string]: unknown
}

/** 群成员 / 入群申请等事件的 `d`：openid 在顶层而不在 author 里 */
export interface RawGroupEvent {
  group_openid?: string
  member_openid?: string
  user_openid?: string
  op_member_openid?: string
  username?: string
  join_request_id?: string
  timestamp?: number | string
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
  InputNotify: 6,
  Media: 7,
} as const

export const FileType = {
  image: 1,
  video: 2,
  voice: 3,
  file: 4,
} as const

/** 从 message_scene.ext 里取 msg_idx（可被引用的 ref index） */
export function extractRefIndex(d: RawMessageEvent | undefined): string | undefined {
  const ext = d?.message_scene?.ext
  if (!Array.isArray(ext)) return undefined
  for (const item of ext) {
    if (typeof item === 'string' && item.startsWith('msg_idx=')) return item.slice('msg_idx='.length)
  }
  return undefined
}
