import type { RawMessageEvent } from '@qqbot/api'
import { describe, expect, it } from 'vitest'
import { buildSession } from './session.js'

function session(message: Partial<RawMessageEvent>) {
  return buildSession({ op: 0, t: 'GROUP_MESSAGE_CREATE', d: { id: 'm1', group_openid: 'G', ...message } }, {
    botId: '123', maxPassiveReplies: 5,
    sender: { sendMessage: async () => ({ ok: true, status: 200, raw: null }) },
  })
}

describe('displayContent', () => {
  it('保留普通群友与其他机器人的提及位置，只移除自己，命令正文不变', () => {
    const content = ' <@!ABC> 请提醒 <@DEF> 开会，再通知 <@EEE> '
    const result = session({ content, mentions: [
      { id: 'ABC', username: '本机器人', is_you: true },
      { id: 'DEF', username: '张三' },
      { id: 'EEE', username: '另一个机器人', bot: true },
    ] })
    expect(result.content).toBe('请提醒  开会，再通知')
    expect(result.displayContent).toBe('请提醒 @张三 开会，再通知 @另一个机器人')
    expect((result.raw as RawMessageEvent).content).toBe(content)
  })

  it('名字缺失时保留原始提及，不猜测开头的未知 @ 是自己', () => {
    expect(session({ content: '<@UNKNOWN> 通知 <@!DEF>' }).displayContent).toBe('<@UNKNOWN> 通知 <@!DEF>')
    expect(session({ content: '<@123> hi <@DEF>', mentions: [{ member_openid: 'DEF', nickname: '李四' }] }).displayContent)
      .toBe('hi @李四')
  })

  it('UTF-8 表情描述可读，损坏的 base64/JSON 退化为表情占位，原 content 保留', () => {
    const ext = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify({ text: '满头问号' }))))
    const content = `你好<faceType=4,faceId="",ext="${ext}"><faceType=4,ext="???"><faceType=1,ext="bnVsbA==">`
    const result = session({ content })
    expect(result.displayContent).toBe('你好[表情:满头问号][表情][表情]')
    expect(result.content).toBe(content)
    expect(session({}).displayContent).toBe('')
  })
})
