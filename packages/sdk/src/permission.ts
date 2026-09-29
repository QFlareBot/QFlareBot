import type { PermissionTier } from './plugin.js'
import type { Session } from './session.js'

/**
 * 发起人够不够得上这一层权限，和命令、正则的 `permission` 是同一个判断（达标制，上层自动通过下层）：
 * Bot 管理员 ＞ 群主与群管理员 ＞ 普通成员。单聊和频道没有群角色，只分 Bot 管理员 / 普通成员两档；
 * 按钮回调同样不带群角色，所以回调里 `group_admin` 也只有 Bot 管理员过得去。
 *
 * ```ts
 * if (!meetsPermission(session, 'group_admin')) return '只有群主、群管理员能重置'
 * ```
 *
 * 不认识的层级按 `member` 处理（人人通过），和命令门槛一致。
 */
export function meetsPermission(
  session: Pick<Session, 'isBotAdmin' | 'memberRole'>,
  required: PermissionTier | undefined,
): boolean {
  if (required === 'bot_admin') return session.isBotAdmin === true
  if (required === 'group_admin') {
    return session.isBotAdmin === true || session.memberRole === 'owner' || session.memberRole === 'admin'
  }
  return true
}
