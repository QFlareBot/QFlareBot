import { definePlugin } from '@qqbot/sdk'

const SCENE_LABEL: Record<string, string> = { group: '群聊', c2c: '单聊', guild: '频道', guild_dm: '频道私聊' }
const ROLE_LABEL: Record<string, string> = { owner: '群主', admin: '群管理员', member: '普通成员' }

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
        const lines = [
          `用户 OpenID：${session.userId || '（未知）'}`,
          `${SCENE_LABEL[session.scene] ?? session.scene} ID：${session.targetId || '（未知）'}`,
        ]
        if (session.memberRole) lines.push(`群角色：${ROLE_LABEL[session.memberRole] ?? session.memberRole}`)
        lines.push(`机器人 AppID：${session.botId}`)
        if (session.avatarUrl) lines.push(`头像：${session.avatarUrl}`)
        return lines.join('\n')
      },
    },
  },
})
