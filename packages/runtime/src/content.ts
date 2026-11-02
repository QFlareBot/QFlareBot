import type { RawMessageEvent } from '@qqbot/api'
import { parseMentionTags } from '@qqbot/sdk'

function replaceMentions(content: string, replacement: (id: string, tag: string) => string): string {
  const parts: string[] = []
  let end = 0
  for (const tag of parseMentionTags(content)) {
    parts.push(content.slice(end, tag.index))
    const value = replacement(tag.id, tag.text)
    end = tag.index + tag.text.length
    // 删除夹在词之间的提及不能把两边拼成新命令/新单词；原有空白照常保留。
    const joinsWords = !value && /\S/.test(content[tag.index - 1] ?? '') && /\S/.test(content[end] ?? '')
    parts.push(joinsWords ? ' ' : value)
  }
  parts.push(content.slice(end))
  return parts.join('')
}

/** 命令正文保留既有的去 @ 语义；收件人守卫必须先使用 raw 判断，不能拿此正文推断。 */
export function cleanContent(content: string | undefined): string {
  return replaceMentions(content ?? '', () => '').trim()
}

/** 展示正文与命令正文分开：只删明确的自身提及，未知的 @ 保留，避免猜错后丢失对象。 */
export function displayContent(message: RawMessageEvent, botId: string, botUserId?: string): string {
  const self = new Set([botId, ...(botUserId ? [botUserId] : [])])
  const notSelf = new Set<string>()
  const names = new Map<string, string>()
  for (const mention of message.mentions ?? []) {
    for (const id of [mention.id, mention.member_openid, mention.user_openid]) {
      if (!id) continue
      if (mention.scope === 'all' || mention.is_you === false) notSelf.add(id)
      else if (mention.is_you === true) self.add(id)
      const name = mention.nickname || mention.username
      if (name) names.set(id, name)
    }
  }
  return replaceMentions(message.content ?? '', (id, tag) =>
    self.has(id) && !notSelf.has(id) ? '' : names.has(id) ? `@${names.get(id)}` : tag)
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
