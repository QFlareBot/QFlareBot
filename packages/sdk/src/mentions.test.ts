import { describe, expect, it } from 'vitest'
import { mentionedUsers } from './mentions.js'
import type { Mention } from './session.js'

const session = (content: string, mentions: Mention[] = [], botId = 'APPID') => ({ botId, mentions, raw: { content } })

describe('mentionedUsers', () => {
  it('全体艾特不能作为群友参数，原文里的全体标记也不能重新补回来', () => {
    expect(mentionedUsers(session('操作 <@ALL_ID> <@all> <@everyone> <@A>', [
      { id: 'ALL_ID', username: '全体成员', bot: false, scope: 'all' },
      { id: 'A', username: '阿', bot: false, scope: 'single' },
    ]))).toEqual([{ id: 'A', username: '阿' }])
    expect(mentionedUsers(session('操作 <qqbot-at-user id="everyone" />'))).toEqual([])
  })

  it('新版 QQ 艾特与旧版混用时仍能提取参数中的群友，并按正文顺序排序', () => {
    expect(mentionedUsers(session('<qqbot-at-user id="BOT" /> 决斗 <qqbot-at-user id="B" /> <@A>', [
      { id: 'A', username: '阿', bot: false }, { id: 'B', username: '乙', bot: false },
    ]))).toEqual([{ id: 'B', username: '乙' }, { id: 'A', username: '阿' }])
    expect(mentionedUsers(session('<qqbot-at-user id="BOT" /> 摸 <qqbot-at-user id="A" />')))
      .toEqual([{ id: 'A', username: '' }])
  })

  it('按在正文里出现的先后排，去掉机器人（mentions 里标了 bot 的）', () => {
    const s = session('<@BOT> 决斗 <@B> <@A>', [
      { id: 'A', username: '阿', bot: false },
      { id: 'BOT', username: '机器人', bot: true },
      { id: 'B', username: '', bot: false },
    ])
    expect(mentionedUsers(s)).toEqual([
      { id: 'B', username: '' },
      { id: 'A', username: '阿' },
    ])
  })

  it('mentions 里没有时退回正文里的 <@…>，开头那一串当作在叫机器人', () => {
    // 没开全量消息的群：mentions 只有空的，被 @ 的群友只在正文里；开头的 BOT 没被标出来
    expect(mentionedUsers(session('<@BOT> 购买奴隶 <@A>'))).toEqual([{ id: 'A', username: '' }])
    // 开头的 id 后面再出现也不算
    expect(mentionedUsers(session('<@BOT> 摸 <@BOT> <@A>'))).toEqual([{ id: 'A', username: '' }])
    // mentions 标了是普通人的，在开头也照算
    expect(mentionedUsers(session('<@A> 摸', [{ id: 'A', username: '阿', bot: false }]))).toEqual([{ id: 'A', username: '阿' }])
  })

  it('去重、补昵称，机器人自己的 AppID 与频道的 <@!id> 形状', () => {
    const s = session('摸 <@!123> <@APPID> <@123>', [
      { id: '123', username: '', bot: false },
      { id: '123', username: '小明', bot: false },
    ])
    expect(mentionedUsers(s)).toEqual([{ id: '123', username: '小明' }])
  })

  it('没有原始正文（测试替身、模拟器）时按 mentions 的顺序', () => {
    const s = { botId: 'APPID', mentions: [{ id: 'A', username: 'a', bot: false }, { id: 'B', username: 'b', bot: false }], raw: {} }
    expect(mentionedUsers(s).map((u) => u.id)).toEqual(['A', 'B'])
    expect(mentionedUsers({ botId: 'APPID', mentions: [], raw: null })).toEqual([])
  })
})
