import { extractQuotedRefIndex, type RawMessageEvent } from '@qqbot/api'
import type { QuotedMessage } from '@qqbot/sdk'
import { toAttachments } from './attachments.js'

/** message_type 为这个值时是引用消息，被引用的那条在 msg_elements[0] */
const QUOTE_MESSAGE_TYPE = 103

const str = (v: unknown) => (typeof v === 'string' ? v : '')

/**
 * 读出这条消息引用的那条消息（session.quote）。原文和附件照 AstrBot 的 QQ 官方适配器，只在 message_type 为 103 时读 msg_elements[0]。
 * ref index 取 message_scene.ext 的 ref_msg_idx，没有再取 msg_elements[0].msg_idx。
 * id 先看 message_reference.message_id 和 msg_elements[0] 的 id（频道消息有），都没有就拿 ref index 问 `lookup`：
 * 群、单聊的推送不带被引用消息的 id，只能查运行时自己记的对照表（refIndex.ts）。三样都没有就是没引用
 */
export function buildQuote(d: RawMessageEvent, lookup?: (refIndex: string) => string | undefined): QuotedMessage | undefined {
  const element = Number(d.message_type) === QUOTE_MESSAGE_TYPE && Array.isArray(d.msg_elements) ? d.msg_elements[0] : undefined
  const quoted = element && typeof element === 'object' ? element : undefined
  // 发引用回复时我们往 message_reference.message_id 填的是 ref index；推送里出现这种值也只当 ref index，拿去撤回必然失败
  const referenced = str(d.message_reference?.message_id)
  const referencedIsRef = referenced.startsWith('REFIDX_')
  const refIndex = extractQuotedRefIndex(d) || str(quoted?.msg_idx) || (referencedIsRef ? referenced : '') || undefined
  const direct = (referencedIsRef ? '' : referenced) || str(quoted?.id) || str(quoted?.message_id)
  if (!direct && !quoted && !refIndex) return undefined
  return {
    messageId: direct || (refIndex && lookup?.(refIndex)) || '',
    content: str(quoted?.content),
    attachments: toAttachments(quoted?.attachments),
    refIndex,
  }
}
