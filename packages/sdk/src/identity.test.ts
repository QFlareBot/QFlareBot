import { describe, expect, it } from 'vitest'
import { qqAt, qqAvatar } from './identity.js'

describe('qqAvatar', () => {
  it('默认 640 规格，按官方 CDN 规范拼接', () => {
    expect(qqAvatar('1903864677', 'ABCDEF0123456789')).toBe('https://thirdqq.qlogo.cn/qqapp/1903864677/ABCDEF0123456789/640')
  })

  it('支持 40 / 100 / 140 规格', () => {
    for (const size of [40, 100, 140] as const) {
      expect(qqAvatar('bot', 'user', size)).toBe(`https://thirdqq.qlogo.cn/qqapp/bot/user/${size}`)
    }
  })

  it('botId 或 openid 为空时返回空串', () => {
    expect(qqAvatar('', 'user')).toBe('')
    expect(qqAvatar('bot', '')).toBe('')
  })
})

describe('qqAt', () => {
  it('拼出 <@openid> 提及文本', () => {
    expect(qqAt('1A2B3C4D')).toBe('<@1A2B3C4D>')
    expect(qqAt('123456')).toBe('<@123456>')
  })

  it('openid 为空时返回空串', () => {
    expect(qqAt('')).toBe('')
  })
})
