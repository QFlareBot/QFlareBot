import { describe, expect, it } from 'vitest'
import { previewMessage } from './outgoing.js'

describe('previewMessage', () => {
  it('字符串就是纯文本', () => {
    expect(previewMessage('你好')).toMatchObject({ text: '你好', markdown: null, image: null, keyboard: [] })
  })

  it('markdown + 按键：按行拆出按钮，带上动作类型与数据', () => {
    const m = previewMessage({
      markdown: { content: '**标题**' },
      keyboard: {
        content: {
          rows: [
            { buttons: [{ id: 'buy', render_data: { label: '购买', style: 4 }, action: { type: 1, data: 'buy:1' } }] },
            { buttons: [{ render_data: { label: '帮助' }, action: { type: 2, data: '/help', enter: true } }] },
          ],
        },
      },
    })
    expect(m.markdown).toBe('**标题**')
    expect(m.keyboard).toEqual([
      [{ id: 'buy', label: '购买', style: 4, action: 1, data: 'buy:1', enter: false }],
      [{ id: '0', label: '帮助', style: 0, action: 2, data: '/help', enter: true }],
    ])
  })

  it('图片只认 http(s) 和 base64；media 里的图片也当图片', () => {
    expect(previewMessage({ image: { url: 'https://a.test/x.png' } }).image).toBe('https://a.test/x.png')
    expect(previewMessage({ image: { url: 'javascript:alert(1)' } }).image).toBeNull()
    expect(previewMessage({ image: { base64: 'AAAA' } }).image).toBe('data:image/png;base64,AAAA')
    expect(previewMessage({ media: { type: 'image', url: 'https://a.test/y.jpg' } }).image).toBe('https://a.test/y.jpg')
  })

  it('其他富媒体给个标签；键盘模板与引用单独标出', () => {
    const m = previewMessage({ media: { type: 'video', filename: 'a.mp4' }, keyboard: { id: 'tpl_1' }, quote: true })
    expect(m.media).toEqual({ type: 'video', label: 'a.mp4' })
    expect(m.keyboardTemplate).toBe('tpl_1')
    expect(m.quote).toBe(true)
  })

  it('形状不对也不抛', () => {
    expect(() => previewMessage(null)).not.toThrow()
    expect(previewMessage({ keyboard: { content: { rows: 'x' } } }).keyboard).toEqual([])
  })
})
