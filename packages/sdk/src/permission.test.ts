import { describe, expect, it } from 'vitest'
import { meetsPermission } from './permission.js'
import type { PermissionTier } from './plugin.js'
import type { Session } from './session.js'

type Who = Pick<Session, 'isBotAdmin' | 'memberRole'>

const botAdmin: Who = { isBotAdmin: true, memberRole: undefined }
const owner: Who = { isBotAdmin: false, memberRole: 'owner' }
const groupAdmin: Who = { isBotAdmin: false, memberRole: 'admin' }
const member: Who = { isBotAdmin: false, memberRole: 'member' }
/** 单聊、频道、按钮回调：没有群角色 */
const noRole: Who = { isBotAdmin: false, memberRole: undefined }

describe('meetsPermission', () => {
  it('达标制：上层自动通过下层的门槛', () => {
    const table: Array<[Who, PermissionTier, boolean]> = [
      [botAdmin, 'bot_admin', true],
      [botAdmin, 'group_admin', true],
      [owner, 'bot_admin', false],
      [owner, 'group_admin', true],
      [groupAdmin, 'group_admin', true],
      [member, 'group_admin', false],
      [noRole, 'group_admin', false],
    ]
    for (const [who, tier, ok] of table) expect(meetsPermission(who, tier), `${JSON.stringify(who)} ${tier}`).toBe(ok)
  })

  it('member、不写、不认识的层级人人通过（和命令门槛一致）', () => {
    expect(meetsPermission(noRole, 'member')).toBe(true)
    expect(meetsPermission(noRole, undefined)).toBe(true)
    expect(meetsPermission(noRole, 'superuser' as PermissionTier)).toBe(true)
  })

  it('老机器人的会话没有 isBotAdmin：当作不是', () => {
    const legacy = { memberRole: 'owner' } as Who
    expect(meetsPermission(legacy, 'bot_admin')).toBe(false)
    expect(meetsPermission(legacy, 'group_admin')).toBe(true)
  })
})
