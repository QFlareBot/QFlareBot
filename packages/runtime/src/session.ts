import {
  extractRefIndex,
  type RawGroupEvent,
  type RawInteractionEvent,
  type RawMessageEvent,
  type WebhookPayload,
} from '@qqbot/api'
import {
  EVENT_ID_REPLYABLE,
  toEventName,
  type Attachment,
  type Interaction,
  type InteractionCode,
  type InteractionType,
  type OutgoingMessage,
  type Scene,
  type SendOptions,
  type SendResult,
  type SendTarget,
  type Session,
  type StreamChunkOptions,
  type StreamWriter,
} from '@qqbot/sdk'

/** 出站抽象：真实环境是 QQBotClient，测试与 dry-run 用记录器 */
export interface Sender {
  sendMessage(target: SendTarget, message: OutgoingMessage, options?: SendOptions): Promise<SendResult>
  typing?(userOpenid: string, seconds?: number, options?: SendOptions): Promise<SendResult>
  streamChunk?(userOpenid: string, content: string, options: StreamChunkOptions): Promise<SendResult>
  recallMessage?(target: SendTarget, messageId: string): Promise<boolean>
  ackInteraction?(interactionId: string, code?: InteractionCode): Promise<boolean>
}

export interface SessionOptions {
  botId: string
  sender: Sender
  maxPassiveReplies: number
}

const INTERACTION_TYPES: Record<number, InteractionType> = {
  11: 'button',
  12: 'menu',
  13: 'feedback',
  14: 'clear_session',
  15: 'story',
  16: 'switch_model',
  18: 'user_authorize',
  19: 'group_authorize',
  20: 'group_authorize_status',
}

interface Identity {
  scene: Scene
  targetId: string
  userId: string
  userName: string
}

/** 从各类事件的 `d` 推断场景、目标与用户；不同事件的 openid 位置不同 */
function identify(rawType: string, d: RawMessageEvent & RawInteractionEvent & RawGroupEvent): Identity {
  const author = d.author ?? {}
  const userName = author.username ?? d.username ?? ''
  const memberId = author.member_openid ?? d.group_member_openid ?? d.member_openid ?? ''
  const userOpenid = author.user_openid ?? d.user_openid ?? ''

  if (rawType === 'INTERACTION_CREATE') {
    if (d.scene === 'group' || d.group_openid) {
      return { scene: 'group', targetId: d.group_openid ?? '', userId: d.group_member_openid ?? '', userName }
    }
    if (d.scene === 'guild' || d.channel_id) {
      return { scene: 'guild', targetId: d.channel_id ?? '', userId: d.data?.resolved?.user_id ?? '', userName }
    }
    return { scene: 'c2c', targetId: d.user_openid ?? '', userId: d.user_openid ?? '', userName }
  }

  if (rawType.startsWith('GROUP_') || d.group_openid) {
    return { scene: 'group', targetId: d.group_openid ?? '', userId: memberId || userOpenid || author.id || '', userName }
  }
  if (rawType.startsWith('C2C_') || rawType.startsWith('FRIEND_') || rawType === 'SUBSCRIBE_MESSAGE_STATUS') {
    const id = userOpenid || (d.openid as string | undefined) || author.id || ''
    return { scene: 'c2c', targetId: id, userId: id, userName }
  }
  if (rawType === 'DIRECT_MESSAGE_CREATE' && d.guild_id) {
    return { scene: 'guild_dm', targetId: d.guild_id, userId: author.id ?? '', userName }
  }
  if (d.channel_id) {
    return { scene: 'guild', targetId: d.channel_id, userId: author.id ?? '', userName }
  }
  return { scene: 'unknown', targetId: '', userId: userOpenid || author.id || '', userName }
}

/** 去掉频道消息里的 <@!id> 提及与首尾空白 */
function cleanContent(content: string | undefined): string {
  return (content ?? '').replace(/<@!?\d+>/g, '').trim()
}

function toAttachments(d: RawMessageEvent): Attachment[] {
  return (d.attachments ?? [])
    .filter((a) => typeof a.url === 'string')
    .map((a) => {
      const url = a.url!.startsWith('http') ? a.url! : `https://${a.url}`
      const item: Attachment = { url }
      if (a.content_type) item.contentType = a.content_type
      if (a.filename) item.filename = a.filename
      if (a.width) item.width = a.width
      if (a.height) item.height = a.height
      if (a.size) item.size = a.size
      return item
    })
}

function buildInteraction(d: RawInteractionEvent, sender: Sender): Interaction {
  const resolved = d.data?.resolved ?? {}
  const rawType = d.type ?? d.data?.type ?? 0
  let acked = false
  return {
    id: d.id,
    type: INTERACTION_TYPES[rawType] ?? 'unknown',
    rawType,
    buttonId: resolved.button_id ?? '',
    buttonData: resolved.button_data ?? '',
    featureId: resolved.feature_id ?? '',
    messageId: resolved.message_id ?? '',
    feedback: resolved.feedback_opt === 'LIKE' || resolved.feedback_opt === 'UNLIKE' ? resolved.feedback_opt : undefined,
    get acked() {
      return acked
    },
    async ack(code = 0) {
      if (acked || !sender.ackInteraction) return false
      acked = true
      return sender.ackInteraction(d.id, code)
    },
  }
}

export function buildSession(payload: WebhookPayload, options: SessionOptions): Session {
  const rawType = payload.t ?? 'UNKNOWN'
  const d = (payload.d ?? {}) as RawMessageEvent & RawInteractionEvent & RawGroupEvent
  const { scene, targetId, userId, userName } = identify(rawType, d)
  const eventId = payload.id ?? `${rawType}:${d.id ?? Date.now()}`
  const messageId = typeof d.id === 'string' && rawType.includes('MESSAGE') ? d.id : undefined
  const eventReplyId = !messageId && EVENT_ID_REPLYABLE.has(rawType) ? eventId : undefined
  const timestamp =
    typeof d.timestamp === 'number' ? d.timestamp * 1000 : d.timestamp ? Date.parse(d.timestamp) || Date.now() : Date.now()
  const here: SendTarget = { scene, id: targetId }
  const { sender } = options

  // 同一条消息/事件的被动回复由这里统一编号
  let seq = 0
  let lastSent: string | undefined

  const passive = (): SendOptions | null => {
    if (scene === 'unknown' || !targetId) return null
    if (messageId) return { messageId }
    if (eventReplyId) return { eventId: eventReplyId }
    return null
  }

  const track = (result: SendResult): SendResult => {
    if (result.ok && result.messageId) lastSent = result.messageId
    return result
  }

  const fail = (error: string): SendResult => ({ ok: false, status: 0, error, raw: null })

  const resolveQuote = (message: OutgoingMessage): OutgoingMessage => {
    if (typeof message === 'string' || message.quote !== true) return message
    const { quote: _q, ...rest } = message
    const refIndex = extractRefIndex(d)
    return refIndex ? { ...rest, quote: refIndex } : rest
  }

  const session: Session = {
    botId: options.botId,
    platform: 'qq',
    event: toEventName(rawType),
    rawType,
    id: eventId,
    timestamp,
    raw: payload.d,
    scene,
    targetId,
    userId,
    userName,
    messageId,
    refIndex: extractRefIndex(d),
    canReply: passive() !== null,
    content: cleanContent(d.content),
    attachments: toAttachments(d),
    interaction: rawType === 'INTERACTION_CREATE' ? buildInteraction(d, sender) : undefined,

    async reply(message) {
      const base = passive()
      if (!base) return fail('当前事件不支持被动回复')
      if (seq >= options.maxPassiveReplies) return fail(`被动回复已达上限 ${options.maxPassiveReplies} 条`)
      seq += 1
      return track(await sender.sendMessage(here, resolveQuote(message), { ...base, msgSeq: seq }))
    },

    async send(message, target) {
      const to = target ?? here
      if (to.scene === 'unknown' || !to.id) return fail('缺少发送目标')
      return track(await sender.sendMessage(to, resolveQuote(message)))
    },

    async typing(seconds = 10) {
      if (scene !== 'c2c' || !sender.typing) return fail('输入中状态仅支持单聊')
      return sender.typing(targetId, seconds, passive() ?? {})
    },

    stream(): StreamWriter {
      const base = passive()
      const canStream = scene === 'c2c' && !!sender.streamChunk && !!base
      let index = 0
      let streamId: string | undefined
      const buffer: string[] = []

      const push = async (chunk: string, final: boolean): Promise<SendResult> => {
        seq += 1
        const opts: StreamChunkOptions = { ...base!, msgSeq: seq, index, final }
        if (streamId) opts.streamId = streamId
        const result = await sender.streamChunk!(targetId, chunk, opts)
        if (result.ok && result.messageId && !streamId) streamId = result.messageId
        index += 1
        return result
      }

      return {
        get messageId() {
          return streamId
        },
        async write(chunk) {
          if (!canStream) {
            buffer.push(chunk)
            return { ok: true, status: 0, raw: null }
          }
          return push(chunk, false)
        },
        async end(chunk) {
          if (!canStream) {
            if (chunk) buffer.push(chunk)
            return session.reply(buffer.join(''))
          }
          return push(chunk ?? '', true)
        },
      }
    },

    async recall(id) {
      const target = id ?? lastSent
      if (!target || !sender.recallMessage || scene === 'unknown') return false
      return sender.recallMessage(here, target)
    },
  }
  return session
}
