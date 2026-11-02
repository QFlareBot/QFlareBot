import type { RawMessageEvent } from '@qqbot/api'
import { mentionedUsers } from '@qqbot/sdk'
import { describe, expect, it } from 'vitest'
import { buildSession } from './session.js'

function session(message: Partial<RawMessageEvent> = {}, rawType = 'GROUP_MESSAGE_CREATE', botUserId = '') {
  return buildSession({
    op: 0,
    t: rawType,
    d: {
      id: 'm1',
      content: '/echo hi',
      author: { id: 'U1' },
      ...(rawType.startsWith('GROUP_') ? { group_openid: 'G1' } : { channel_id: 'C1', guild_id: 'GD1' }),
      ...message,
    },
  }, {
    botId: '123',
    botUserId,
    maxPassiveReplies: 5,
    sender: { sendMessage: async () => ({ ok: true, status: 200, raw: null }) },
  })
}

describe('消息收件人必须在清理 @ 之前判断', () => {
  it.each(['GROUP_MESSAGE_CREATE', 'MESSAGE_CREATE'])(
    '%s：明确 @ 其他机器人不能被斜杠重新唤醒', (rawType) => {
      const s = session({ content: '<@D4E5F6>/echo hi', mentions: [{ id: 'D4E5F6', bot: true, is_you: false }] }, rawType)
      expect(s.content).toBe('/echo hi')
      expect(s.atMe).toBe(false)
      expect(s.addressedToOthers).toBe(true)
    },
  )

  it.each([
    { mentions: [{ scope: 'all', is_you: true }] },
    { mentions: [{ scope: 'all', member_openid: '123', is_you: true }], content: '<@123> /echo hi' },
    { mention_everyone: true },
    { content: '<@everyone> /echo hi' },
    { content: '<@all> /echo hi' },
    { content: '@全体成员 /echo hi' },
  ] satisfies Partial<RawMessageEvent>[])('@全体不等于单独 @ 本机器人：%j', (message) => {
    for (const type of ['GROUP_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE', 'MESSAGE_CREATE', 'AT_MESSAGE_CREATE']) {
      expect(session(message, type)).toMatchObject({ atMe: false, addressedToOthers: true })
    }
  })

  it('同时明确 @ 本机器人和别人/全体仍然可以唤醒', () => {
    expect(session({ content: '<@D4E5F6> <@ABC> /echo hi', mentions: [
      { id: 'D4E5F6', bot: true, is_you: false }, { id: 'ABC', is_you: true }, { scope: 'all' },
    ] })).toMatchObject({ atMe: true, addressedToOthers: false })
  })

  it('归一化保留全体范围，成员提取不会把全体当成命令目标', () => {
    const s = session({
      content: '<@SELF> /echo <@ALL_ID> <@MEMBER>',
      mentions: [
        { member_openid: 'SELF', is_you: true, scope: 'single' },
        { member_openid: 'ALL_ID', nickname: '全体成员', scope: 'all' },
        { member_openid: 'MEMBER', nickname: '群友', scope: 'single' },
      ],
    })
    expect(s).toMatchObject({ atMe: true, addressedToOthers: false })
    expect(mentionedUsers(s)).toEqual([{ id: 'MEMBER', username: '群友' }])
  })

  it('正文只是提到“@全体成员”这个词时，不把它当成平台的全体艾特', () => {
    expect(session({ content: '/怎么关闭 @全体成员 提醒' }))
      .toMatchObject({ atMe: false, addressedToOthers: false })
  })

  it('只在原文开头 @ 别人才阻止指令，命令后面的 @ 仍然可以是参数', () => {
    expect(session({ content: ' \n<@!ABC> /echo hi' })).toMatchObject({ atMe: false, addressedToOthers: true })
    expect(session({ content: '/echo <@ABC>', mentions: [{ id: 'ABC', bot: false }] }))
      .toMatchObject({ atMe: false, addressedToOthers: false, content: '/echo' })
    expect(session()).toMatchObject({ atMe: false, addressedToOthers: false })
  })

  it('全量消息只凭自身 ID 或 is_you 判断，不凭 bot 标记', () => {
    expect(session({ content: '<@123> hello' }, 'MESSAGE_CREATE').atMe).toBe(true)
    expect(session({ mentions: [{ id: 'ABC', bot: true }] }, 'MESSAGE_CREATE').atMe).toBe(false)
    expect(session({ mentions: [{ member_openid: 'ABC', is_you: true }] }).atMe).toBe(true)
    expect(session({ mentions: [{ user_openid: '123' }] }, 'MESSAGE_CREATE').atMe).toBe(true)
  })

  it('专用 @ 事件兼容缺少 mentions、自身 openid 不同于 AppID 和已剥去自身 @', () => {
    expect(session({}, 'GROUP_AT_MESSAGE_CREATE')).toMatchObject({ atMe: true, addressedToOthers: false })
    expect(session({ content: '<@ABC> hello', mentions: [{ id: 'ABC', bot: true }] }, 'AT_MESSAGE_CREATE').atMe).toBe(true)
    expect(session({ content: '/echo <@ABC>', mentions: [{ id: 'ABC', is_you: false }] }, 'GROUP_AT_MESSAGE_CREATE').atMe).toBe(true)
  })

  it.each(['GROUP_AT_MESSAGE_CREATE', 'AT_MESSAGE_CREATE'])(
    '%s：平台已省略自身 @，剩余的开头 @ 可以是参数，不能推翻专用事件', (rawType) => {
      const s = session({ content: '<@ABC> /echo hi', mentions: [{ id: 'ABC', is_you: false, bot: false }] }, rawType)
      expect(s).toMatchObject({ atMe: true, addressedToOthers: false, content: '/echo hi' })
    },
  )

  it.each(['<@ABC>', '<@!ABC>', '<qqbot-at-user id="ABC" />'])(
    '新旧 @ 格式遵守相同的收件人规则：%s', (tag) => {
      expect(session({ content: `${tag}/echo hi`, mentions: [{ id: 'ABC', is_you: false, bot: true }] }))
        .toMatchObject({ atMe: false, addressedToOthers: true, content: '/echo hi' })
      expect(session({ content: `${tag}/echo hi`, mentions: [{ id: 'ABC', is_you: true }] }))
        .toMatchObject({ atMe: true, addressedToOthers: false, content: '/echo hi', displayContent: '/echo hi' })
    },
  )

  it('已知频道用户 ID 不同时，专用事件中的其他机器人成员仍可作为参数', () => {
    const s = session({ content: '<@!789> /echo hi', mentions: [{ id: '789', bot: true }] }, 'AT_MESSAGE_CREATE', '456')
    expect(s).toMatchObject({ atMe: true, addressedToOthers: false })
  })

  it('频道按已保存的机器人用户 ID 匹配自身，不把 AppID 与用户 ID 混为一谈', () => {
    const s = session({ content: '<@!456> /echo hi', mentions: [{ id: '456', bot: true }] }, 'MESSAGE_CREATE', '456')
    expect(s).toMatchObject({ atMe: true, addressedToOthers: false })
  })

  it('引用中的 @本机器人/@其他机器人/@全体都不影响当前消息的收件人', () => {
    for (const quotedContent of ['<@123> /echo', '<@ABC> /echo', '<@everyone> /echo']) {
      const quote = { message_type: 103, msg_elements: [{ msg_idx: 'REFIDX_quote', content: quotedContent }] }
      expect(session({ ...quote, content: '同意' })).toMatchObject({ atMe: false, addressedToOthers: false })
      expect(session({ ...quote, content: '<@123> 同意' })).toMatchObject({ atMe: true, addressedToOthers: false })
      expect(session({ ...quote, content: '/echo hi' })).toMatchObject({ atMe: false, addressedToOthers: false })
    }
  })

  it.each(['GROUP_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE', 'MESSAGE_CREATE', 'AT_MESSAGE_CREATE'])(
    '%s：引用 @全体的消息不能仅靠专用事件名被当成 @自己', (rawType) => {
      const quote = { message_type: 103, msg_elements: [{ msg_idx: 'REFIDX_quote', content: '<@everyone> 集合' }] }
      expect(session({ ...quote, content: '收到' }, rawType))
        .toMatchObject({ atMe: false, addressedToOthers: false })
      expect(session({ ...quote, content: '请问 <@ABC> 怎么办', mentions: [{ id: 'ABC', is_you: true }] }, rawType))
        .toMatchObject({ atMe: true, addressedToOthers: false, content: '请问  怎么办' })
      expect(session({ ...quote, content: '/echo hi' }, rawType))
        .toMatchObject({ atMe: false, addressedToOthers: false, content: '/echo hi' })
    },
  )

  it.each([
    { message_type: 103 },
    { message_type: 103, msg_elements: [] },
    { message_reference: { message_id: 'quoted' } },
    { message_scene: { ext: ['ref_msg_idx=REFIDX_quote'] } },
    { message_type: 103, msg_elements: [{ content: '原文没有任何艾特' }] },
  ])('不同引用结构均不能仅靠 @ 事件类型唤醒：%j', (quote) => {
    expect(session({ ...quote, content: '收到' }, 'GROUP_AT_MESSAGE_CREATE'))
      .toMatchObject({ atMe: false, addressedToOthers: false })
  })

  it.each(['<@ABC>', '<@!ABC>', '<qqbot-at-user id="ABC" />'])(
    '本机器人的 @ 不在开头仍能识别，而且保留前面的文字：%s', (tag) => {
      expect(session({ content: `你好 ${tag} 帮我看看`, mentions: [{ id: 'ABC', is_you: true }] }))
        .toMatchObject({ atMe: true, addressedToOthers: false, content: '你好  帮我看看', displayContent: '你好  帮我看看' })
    },
  )

  it('私聊不受 @其他人/全体的群聊收件规则影响，非消息事件不唤醒', () => {
    expect(session({ mentions: [{ scope: 'all', is_you: true }] }, 'DIRECT_MESSAGE_CREATE'))
      .toMatchObject({ atMe: true, addressedToOthers: false })
    expect(session({ mentions: [{ is_you: true }] }, 'GROUP_ADD_ROBOT'))
      .toMatchObject({ atMe: false, addressedToOthers: false })
  })
})
