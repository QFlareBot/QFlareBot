import type { Session } from './session.js'

/** 消息里被 @ 的一个人 */
export interface MentionedUser {
  id: string
  /** 平台给了才有，取不到是空串 */
  username: string
}

const AT = /<@!?([0-9A-Za-z_-]+)>/g

/**
 * 消息里 @ 了谁（不含机器人），按在消息里出现的先后排——`/决斗 @A @B` 要分得清谁是谁。
 *
 * 1. `session.mentions`：标了 bot（含 is_you）的是机器人，不算。
 * 2. 原始正文里的 `<@openid>`：没开全量消息的群里「@机器人 购买奴隶 @群友」，被 @ 的群友可能只在正文里、不在 mentions 里。
 *    机器人在群里的 openid 和 AppID 不是一个，mentions 没标出来时认不出它，所以正文开头、命令前面那一串 @
 *    当作在叫机器人，只从正文里认出来的不算（mentions 里标了是普通人的照算）。
 *
 * ```ts
 * const [target] = mentionedUsers(session)
 * if (!target) return '请 @ 一个群友'
 * ```
 */
export function mentionedUsers(session: Pick<Session, 'botId' | 'mentions' | 'raw'>): MentionedUser[] {
  const bots = new Set<string>([session.botId])
  const users: MentionedUser[] = []
  for (const m of session.mentions) {
    if (!m.id) continue
    if (m.bot) {
      bots.add(m.id)
      continue
    }
    const known = users.find((u) => u.id === m.id)
    if (!known) users.push({ id: m.id, username: m.username })
    else if (!known.username) known.username = m.username
  }

  const raw = session.raw as { content?: unknown } | null | undefined
  const content = typeof raw?.content === 'string' ? raw.content : ''
  // 开头那一串认作机器人：它们后面再出现也不算
  const head = /^(?:\s*<@!?[0-9A-Za-z_-]+>)+/.exec(content)?.[0] ?? ''
  const leading = new Set([...head.matchAll(AT)].map((m) => m[1]!))
  for (const m of content.matchAll(AT)) {
    const id = m[1]!
    if (!bots.has(id) && !leading.has(id) && !users.some((u) => u.id === id)) users.push({ id, username: '' })
  }

  const position = (id: string) => {
    const i = content.search(new RegExp(`<@!?${id.replace(/[^0-9A-Za-z_-]/g, '')}>`))
    return i < 0 ? Number.MAX_SAFE_INTEGER : i
  }
  return users
    .filter((u) => !bots.has(u.id))
    .map((u, i) => ({ u, i, pos: position(u.id) }))
    .sort((a, b) => a.pos - b.pos || a.i - b.i)
    .map((x) => x.u)
}
