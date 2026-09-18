import type { HandlerResult, Reply } from './plugin.js'
import type { SendResult, Session } from './session.js'

/** 字符串或消息对象（排除可迭代对象，避免把生成器当成消息） */
export function isReply(value: unknown): value is Reply {
  if (typeof value === 'string') return true
  if (typeof value !== 'object' || value === null) return false
  return !(Symbol.asyncIterator in value) && !(Symbol.iterator in value)
}

/**
 * 把处理器的返回值投递出去：单条回复一次，可迭代对象逐条回复。
 * 当前事件不能被动回复时退化为主动发送。返回投递结果列表。
 */
export async function deliverReply(session: Session, result: HandlerResult): Promise<SendResult[]> {
  if (result === undefined || result === null) return []
  const out = (message: Reply) => (session.canReply ? session.reply(message) : session.send(message))
  if (isReply(result)) return [await out(result)]
  const results: SendResult[] = []
  for await (const item of result as AsyncIterable<Reply> | Iterable<Reply>) {
    if (isReply(item)) results.push(await out(item))
  }
  return results
}
