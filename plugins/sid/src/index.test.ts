import { describe, expect, it } from 'vitest'
import { runCommand } from '@qqbot/sdk/testing'
import sid from './index.js'

describe('sid 插件', () => {
  it('回复包含用户 OpenID 与会话 ID', async () => {
    const session = await runCommand(sid, 'sid')
    const reply = String(session.replies[0])
    expect(reply).toContain('mock-user')
    expect(reply).toContain('mock-group')
    expect(reply).toContain('test-bot')
  })

  it('群聊时带上群角色，别名 id 也能触发', async () => {
    const session = await runCommand(sid, 'id', '', { session: { memberRole: 'owner' } })
    expect(String(session.replies[0])).toContain('群主')
  })

  it('单聊没有群角色，不输出该行', async () => {
    const session = await runCommand(sid, 'sid', '', { session: { scene: 'c2c', targetId: 'U1' } })
    const reply = String(session.replies[0])
    expect(reply).not.toContain('群角色')
    expect(reply).toContain('U1')
  })
})
