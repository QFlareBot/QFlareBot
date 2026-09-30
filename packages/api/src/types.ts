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
  attachments?: RawAttachment[]
  /**
   * `is_you`：被 @ 的是不是本机器人（群全量消息靠它判断，`bot` 只说明对方是机器人）。
   * 被 @ 者的 id / 名字：线上群全量消息带 `id` / `username`（今日老婆的强娶记录能对上，AstrBot 也读这两个）；
   * 腾讯官方适配器 openclaw-qqbot 的类型里另有 `member_openid` / `nickname`，两套都读
   */
  mentions?: Array<{
    id?: string
    member_openid?: string
    user_openid?: string
    username?: string
    nickname?: string
    bot?: boolean
    is_you?: boolean
    scope?: string
  }>
  /** ext 形如 ["msg_idx=REFIDX_...", "auth_token=..."]；引用了别的消息时还有 "ref_msg_idx=REFIDX_..." */
  message_scene?: { source?: string; ext?: string[] }
  /** 103 是引用消息：被引用的那条放在 msg_elements[0] */
  message_type?: number
  /** 被引用消息的 id。群、单聊的引用消息没有这个字段，只有 ext 里的 ref_msg_idx（见腾讯官方适配器 openclaw-qqbot 的类型） */
  message_reference?: { message_id?: string }
  /** 被引用的那条：腾讯官方适配器的类型里只有 msg_idx、原文和附件，没有消息 id；id / message_id 照 AstrBot 也读 */
  msg_elements?: Array<{ id?: string; message_id?: string; msg_idx?: string; content?: string; attachments?: RawAttachment[] }>
  [key: string]: unknown
}

export interface RawAttachment {
  url?: string
  content_type?: string
  filename?: string
  width?: number
  height?: number
  size?: number
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

/** message_scene.ext 里 `key=` 开头那一项的值 */
function sceneExt(d: RawMessageEvent | undefined, key: string): string | undefined {
  const ext = d?.message_scene?.ext
  if (!Array.isArray(ext)) return undefined
  for (const item of ext) {
    if (typeof item === 'string' && item.startsWith(`${key}=`)) return item.slice(key.length + 1)
  }
  return undefined
}

/** 从 message_scene.ext 里取 msg_idx（可被引用的 ref index） */
export function extractRefIndex(d: RawMessageEvent | undefined): string | undefined {
  return sceneExt(d, 'msg_idx')
}

/** 这条消息引用的那条消息的 ref index（message_scene.ext 里的 ref_msg_idx），没引用时没有 */
export function extractQuotedRefIndex(d: RawMessageEvent | undefined): string | undefined {
  return sceneExt(d, 'ref_msg_idx')
}
