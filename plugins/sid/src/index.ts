import { definePlugin } from '@qqbot/sdk'
import type { OutgoingMessage, Session } from '@qqbot/sdk'

const SCENE_LABEL: Record<string, string> = { group: '群聊', c2c: '单聊', guild: '频道', guild_dm: '频道私聊' }
const ROLE_LABEL: Record<string, string> = { owner: '群主', admin: '群管理员', member: '普通成员' }

/** 机器人名是用户起的，可能带 markdown 符号 */
const escapeMarkdown = (text: string) => text.replace(/[\\`*_~[\]()#>|<]/g, '\\$&')

/**
 * 内置的身份查询插件：配置 Bot 管理员名单（快照 admins）前，
 * 先在目标会话里发 /sid 拿到 openid。openid 按机器人隔离，别处复制来的是无效的。
 */
export default definePlugin({
  name: 'sid',
  displayName: '会话信息',
  description: '查询自己的 OpenID、当前会话 ID、群角色与头像链接',
  commands: {
    sid: {
      description: '查看本会话的身份信息',
      aliases: ['id'],
      handler({ session }) {
        // 群聊、单聊的原生 markdown 对所有机器人开放，代码块自带复制按钮；频道要单独开通，只能发纯文本
        return session.scene === 'group' || session.scene === 'c2c' ? markdownReply(session) : textReply(session)
      },
    },
  },
})

function textReply(session: Session): string {
  const lines = [
    `用户 OpenID：${session.userId || '（未知）'}`,
    `${sceneLabel(session)} ID：${session.targetId || '（未知）'}`,
  ]
  if (session.memberRole) lines.push(`群角色：${roleLabel(session)}`)
  lines.push(
    session.botName ? `机器人：${session.botName}（AppID：${session.botId}）` : `机器人 AppID：${session.botId}`,
  )
  if (session.avatarUrl) lines.push(`头像：${session.avatarUrl}`)
  return lines.join('\n')
}

/** 每个 ID 单独一个代码块，复制出来只有值本身 */
function markdownReply(session: Session): OutgoingMessage {
  const lines = [
    '用户 OpenID',
    ...codeBlock(session.userId),
    `${sceneLabel(session)} ID`,
    ...codeBlock(session.targetId),
  ]
  if (session.memberRole) lines.push(`群角色：${roleLabel(session)}`)
  lines.push(
    session.botName
      ? `机器人：${escapeMarkdown(session.botName)}（AppID：${session.botId}）`
      : `机器人 AppID：${session.botId}`,
  )
  if (session.avatarUrl) lines.push(`头像：\`${session.avatarUrl}\``)
  return { markdown: { content: lines.join('\n') } }
}

function codeBlock(value: string): string[] {
  return value ? ['```', value, '```'] : ['（未知）']
}

function sceneLabel(session: Session): string {
  return SCENE_LABEL[session.scene] ?? session.scene
}

function roleLabel(session: Session): string {
  return ROLE_LABEL[session.memberRole!] ?? session.memberRole!
}
