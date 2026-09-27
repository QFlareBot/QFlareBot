import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown } from './miniMarkdown.js'

describe('parseMarkdown', () => {
  it('代码块原样保留，前后的段落分开', () => {
    expect(parseMarkdown('用户 OpenID\n```\ntest-user\n```\n头像')).toEqual([
      { t: 'p', inl: [{ t: 'text', v: '用户 OpenID' }] },
      { t: 'code', v: 'test-user' },
      { t: 'p', inl: [{ t: 'text', v: '头像' }] },
    ])
  })

  it('标题、引用、列表、分隔线', () => {
    expect(parseMarkdown('## 排行\n> 注意\n- 一\n2. 二\n***').map((b) => b.t)).toEqual(['h', 'quote', 'li', 'li', 'hr'])
    expect(parseMarkdown('2. 二')[0]).toMatchObject({ t: 'li', marker: '2.' })
  })

  it('没闭合的代码块吃到结尾，不抛', () => {
    expect(parseMarkdown('```\na\nb')).toEqual([{ t: 'code', v: 'a\nb' }])
  })
})

describe('parseInline', () => {
  it('行内代码、粗体、斜体', () => {
    expect(parseInline('用 `/sid` 查 **自己** 的 *id*')).toEqual([
      { t: 'text', v: '用 ' },
      { t: 'code', v: '/sid' },
      { t: 'text', v: ' 查 ' },
      { t: 'bold', v: '自己' },
      { t: 'text', v: ' 的 ' },
      { t: 'italic', v: 'id' },
    ])
  })

  it('图片去掉 QQ 的尺寸标记；链接和图片只认 http(s)', () => {
    expect(parseInline('![头像 #208px #320px](https://a.test/x.png)')).toEqual([{ t: 'image', alt: '头像', src: 'https://a.test/x.png' }])
    expect(parseInline('[官网](https://a.test)')).toEqual([{ t: 'link', v: '官网', href: 'https://a.test' }])
    const unsafe = parseInline('[点我](javascript:alert(1))')
    expect(unsafe.every((x) => x.t === 'text')).toBe(true)
    expect(unsafe[0]).toEqual({ t: 'text', v: '点我' })
  })
})
