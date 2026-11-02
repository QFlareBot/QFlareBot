import type { RawMessageEvent } from '@qqbot/api'
import { parseMentionTags, type Scene } from '@qqbot/sdk'

type RawMention = NonNullable<RawMessageEvent['mentions']>[number]

interface AddressingOptions {
  rawType: string
  scene: Scene
  botId: string
  botUserId: string
  hasQuote: boolean
}

const idsOf = (mention: RawMention): string[] =>
  [mention.id, mention.member_openid, mention.user_openid].filter((id): id is string => typeof id === 'string' && !!id)
const isAll = (mention: RawMention): boolean => mention.scope === 'all'

/**
 * 先用当前消息的原文判断收件人，再清理命令正文。不能把「@别人 /命令」清成「/命令」后抢答。
 * 只从顶层 content / mentions 识别直接提及；引用原文不参与判断，引用存在时禁用 @ 事件兜底。
 */
export function messageAddressing(message: RawMessageEvent, options: AddressingOptions) {
  const { rawType, scene, botId, botUserId, hasQuote } = options
  if (scene === 'c2c' || scene === 'guild_dm') return { atMe: true, addressedToOthers: false }
  if (scene !== 'group' && scene !== 'guild') return { atMe: false, addressedToOthers: false }

  const content = message.content ?? ''
  const mentions = message.mentions ?? []
  // 频道用户 ID 与 AppID 不同；资料中已取得 /users/@me.id 时也用于精确匹配。
  const selfIds = new Set([botId, ...(botUserId ? [botUserId] : [])].filter(Boolean))
  const tags = parseMentionTags(content)
  const leadingMention = !!tags[0] && !content.slice(0, tags[0].index).trim()
  const broadcast =
    message.mention_everyone === true ||
    mentions.some(isAll) ||
    tags.some(({ id }) => id === 'all' || id === 'everyone') ||
    /^\s*@(?:everyone|全体(?:成员)?)(?=\s|$)/.test(content)
  const self = (mention: RawMention) =>
    !isAll(mention) &&
    (mention.is_you === true || (mention.is_you !== false && idsOf(mention).some((id) => selfIds.has(id))))
  // bot:true 只说明是某个机器人，不能证明是本机器人；scope:all 即使带 is_you 也不是单独 @ 自己。
  const directSelf = mentions.some(self) || tags.some(({ id }) =>
    selfIds.has(id) && !mentions.some((mention) =>
      idsOf(mention).includes(id) && (isAll(mention) || mention.is_you === false),
    ),
  )
  // AstrBot 的 force_group_mention：专用 @ 事件可能省略自身提及，剩余开头的 @ 可以是参数。
  // 只有全量事件才靠正文推断是否发给别人。按本框架的策略，单纯 @全体仍不视为单独叫自己。
  // 引用回复不靠事件名推断：它无法证明当前正文单独 @ 了自己（例如引用一条 @全体的消息）。
  // 须有当前消息的明确自身提及，或由上层按当前正文的前缀唤醒；不检查引用原文里的艾特。
  const atEvent = rawType === 'GROUP_AT_MESSAGE_CREATE' || rawType === 'AT_MESSAGE_CREATE'
  const atMe = directSelf || (atEvent && !broadcast && !hasQuote)
  return { atMe, addressedToOthers: !atMe && (broadcast || leadingMention) }
}
