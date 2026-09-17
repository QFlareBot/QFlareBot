import { runCommand } from '@qqbot/sdk/testing'
import { describe, expect, it } from 'vitest'
import plugin from './index.js'

describe('image', () => {
  it('无参数发送内置 base64 图片', async () => {
    const session = await runCommand(plugin, 'image')
    expect(session.replies[0]).toMatchObject({ image: { base64: expect.stringMatching(/^iVBOR/) } })
  })

  it('带 URL 时发送该图片', async () => {
    const session = await runCommand(plugin, 'image', 'https://example.com/a.png')
    expect(session.replies[0]).toMatchObject({ image: { url: 'https://example.com/a.png' } })
  })

  it('提供 /test.png 路由', async () => {
    const res = await plugin.routes![0]!.handler({ ctx: {} as never, request: new Request('https://x/p/image/test.png'), params: {} })
    expect(res.headers.get('content-type')).toBe('image/png')
  })
})
