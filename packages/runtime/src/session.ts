import type { RawMessageEvent, WebhookPayload } from '@qqbot/api'
import { toEventName, type Attachment, type OutgoingMessage, type Scene, type SendResult, type SendTarget, type Session } from '@qqbot/sdk'

/** 出站抽象：真实环境是 QQBotClient，测试与 dry-run 用记录器 */
export interface Sender {
  sendMessage(
    target: SendTarget,
    message: OutgoingMessage,
    options?: { messageId?: string; msgSeq?: number },
  ): Promise<SendResult>
}

export interface SessionOptions {
  botId: string
  sender: Sender
  maxPassiveReplies: number
}

function sceneOf(rawType: string, d: RawMessageEvent): { scene: Scene; targetId: string } {
  if (rawType.startsWith('GROUP_') && d.group_openid) return { scene: 'group', targetId: d.group_openid }
  if (rawType.startsWith('C2C_') || rawType.startsWith('FRIEND_')) {
    return { scene: 'c2c', targetId: d.author?.user_openid ?? d.author?.id ?? '' }
  }
  if (rawType === 'DIRECT_MESSAGE_CREATE' && d.guild_id) return { scene: 'guild_dm', targetId: d.guild_id }
  if (d.channel_id) return { scene: 'guild', targetId: d.channel_id }
  if (d.group_openid) return { scene: 'group', targetId: d.group_openid }
  return { scene: 'unknown', targetId: '' }
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

export function buildSession(payload: WebhookPayload, options: SessionOptions): Session {
  const rawType = payload.t ?? 'UNKNOWN'
  const d = (payload.d ?? {}) as RawMessageEvent
  const { scene, targetId } = sceneOf(rawType, d)
  const messageId = typeof d.id === 'string' && rawType.includes('MESSAGE') ? d.id : undefined
  const timestamp = d.timestamp ? Date.parse(d.timestamp) || Date.now() : Date.now()
  const here: SendTarget = { scene, id: targetId }

  // 同一条消息的被动回复由这里统一编号
  let seq = 0

  const session: Session = {
    botId: options.botId,
    platform: 'qq',
    event: toEventName(rawType),
    rawType,
    id: payload.id ?? `${rawType}:${d.id ?? timestamp}`,
    timestamp,
    raw: payload.d,
    scene,
    targetId,
    userId: d.author?.member_openid ?? d.author?.user_openid ?? d.author?.id ?? '',
    userName: d.author?.username ?? '',
    messageId,
    content: cleanContent(d.content),
    attachments: toAttachments(d),

    async reply(message) {
      if (!messageId || scene === 'unknown') {
        return { ok: false, status: 0, error: '当前事件不支持被动回复', raw: null }
      }
      if (seq >= options.maxPassiveReplies) {
        return { ok: false, status: 0, error: `被动回复已达上限 ${options.maxPassiveReplies} 条`, raw: null }
      }
      seq += 1
      return options.sender.sendMessage(here, message, { messageId, msgSeq: seq })
    },

    async send(message, target) {
      const to = target ?? here
      if (to.scene === 'unknown' || !to.id) {
        return { ok: false, status: 0, error: '缺少发送目标', raw: null }
      }
      return options.sender.sendMessage(to, message)
    },
  }
  return session
}
