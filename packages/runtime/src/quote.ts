import { extractQuotedRefIndex, type RawMessageEvent } from '@qqbot/api'
import type { QuotedMessage } from '@qqbot/sdk'
import { toAttachments } from './attachments.js'

/** message_type 为这个值时是引用消息，被引用的那条在 msg_elements[0] */
const QUOTE_MESSAGE_TYPE = 103

const str = (v: unknown) => (typeof v === 'string' ? v : '')

/**
 * 读出这条消息引用的那条消息（session.quote）。规则照 AstrBot 的 QQ 官方适配器：
 * id 先看 message_reference.message_id，没有再取 msg_elements[0] 的 id；原文和附件只在 message_type 为 103 时读 msg_elements[0]。
 * 另外读 message_scene.ext 的 ref_msg_idx，插件要引用被引用的那条回复时用。三样都没有就是没引用
 */
export function buildQuote(d: RawMessageEvent): QuotedMessage | undefined {
  const element = Number(d.message_type) === QUOTE_MESSAGE_TYPE && Array.isArray(d.msg_elements) ? d.msg_elements[0] : undefined
  const quoted = element && typeof element === 'object' ? element : undefined
  const messageId = str(d.message_reference?.message_id) || str(quoted?.id) || str(quoted?.message_id)
  const refIndex = extractQuotedRefIndex(d)
  if (!messageId && !quoted && !refIndex) return undefined
  return {
    messageId,
    content: str(quoted?.content),
    attachments: toAttachments(quoted?.attachments),
    refIndex,
  }
}
