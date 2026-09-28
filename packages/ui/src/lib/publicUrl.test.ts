import { describe, expect, it } from 'vitest'
import { normalizePublicUrl } from './publicUrl.js'

describe('normalizePublicUrl', () => {
  it('去掉空白和结尾斜杠', () => {
    expect(normalizePublicUrl('  https://bot.example.com/ ')).toBe('https://bot.example.com')
    expect(normalizePublicUrl('https://bot.example.com:8443')).toBe('https://bot.example.com:8443')
  })

  it('空着表示清掉', () => {
    expect(normalizePublicUrl('   ')).toBe('')
  })

  it('不是 https 的 origin 一律不收：http、带路径、带查询、写错', () => {
    for (const bad of ['http://bot.example.com', 'bot.example.com', 'https://bot.example.com/p/meme', 'https://bot.example.com?a=1', 'https://']) {
      expect(normalizePublicUrl(bad)).toBeNull()
    }
  })
})
