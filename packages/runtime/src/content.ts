import type { RawMessageEvent } from '@qqbot/api'

/** 展示正文与命令正文分开：只删明确的自身提及，未知的 @ 保留，避免猜错后丢失对象。 */
export function displayContent(message: RawMessageEvent, botId: string): string {
  const self = new Set([botId])
  const names = new Map<string, string>()
  for (const mention of message.mentions ?? []) {
    for (const id of [mention.id, mention.member_openid, mention.user_openid]) {
      if (!id) continue
      if (mention.is_you === true) self.add(id)
      const name = mention.nickname || mention.username
      if (name) names.set(id, name)
    }
  }
  return (message.content ?? '')
    .replace(/<@!?([0-9A-Za-z_-]+)>/g, (tag, id: string) => self.has(id) ? '' : names.has(id) ? `@${names.get(id)}` : tag)
    .replace(/<faceType=\d+[^>]*>/g, (tag) => {
      const encoded = /\bext="([^"]*)"/.exec(tag)?.[1]
      if (encoded && encoded.length <= 4096) {
        try {
          const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))
          const data = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) as { text?: unknown } | null
          if (typeof data?.text === 'string' && data.text) return `[表情:${data.text}]`
        } catch {
          // 非法 base64/UTF-8/JSON 按普通表情处理，不能影响消息分发。
        }
      }
      return '[表情]'
    })
    .trim()
}
