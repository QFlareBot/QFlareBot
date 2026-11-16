import { describe, expect, it } from 'vitest'
import { runCommand } from '@qqbot/sdk/testing'
import type { OutgoingMessage } from '@qqbot/sdk'
import sid from './index.js'

const markdownOf = (reply: OutgoingMessage | undefined) => {
  if (!reply || typeof reply === 'string') throw new Error('应当回复 markdown')
  return reply.markdown?.content ?? ''
}

describe('sid 插件', () => {
  it('群聊回复 markdown，OpenID 与群 ID 各占一个代码块', async () => {
    const session = await runCommand(sid, 'sid')
    const content = markdownOf(session.replies[0])
    expect(content).toContain('```\nmock-user\n```')
    expect(content).toContain('```\nmock-group\n```')
    expect(content).toContain('test-bot')
  })

  it('群聊时带上群角色，别名 id 也能触发', async () => {
    const session = await runCommand(sid, 'id', '', { session: { memberRole: 'owner' } })
    expect(markdownOf(session.replies[0])).toContain('群主')
  })

  it('群聊分别显示个人昵称与群昵称，并转义 markdown 符号', async () => {
    const session = await runCommand(sid, 'sid', '', { session: { userName: '小_林', groupNickname: '*值班小林*' } })
    const content = markdownOf(session.replies[0])
    expect(content).toContain('个人昵称：小\\_林')
    expect(content).toContain('群昵称：\\*值班小林\\*')
  })

  it('单聊显示个人昵称，没有群昵称和群角色', async () => {
    const session = await runCommand(sid, 'sid', '', { session: { scene: 'c2c', targetId: 'U1' } })
    const content = markdownOf(session.replies[0])
    expect(content).toContain('个人昵称：测试用户')
    expect(content).not.toContain('群昵称')
    expect(content).not.toContain('群角色')
    expect(content).toContain('```\nU1\n```')
  })

  it('机器人名里的 markdown 符号会转义', async () => {
    const session = await runCommand(sid, 'sid', '', { session: { botName: '*小_助手*' } })
    expect(markdownOf(session.replies[0])).toContain('\\*小\\_助手\\*')
  })

  it('频道不支持 markdown，回复纯文本', async () => {
    const session = await runCommand(sid, 'sid', '', { session: { scene: 'guild', targetId: 'CH1' } })
    const reply = session.replies[0]
    expect(typeof reply).toBe('string')
    expect(reply).toContain('mock-user')
    expect(reply).toContain('频道 ID：CH1')
  })
})
