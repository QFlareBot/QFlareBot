import type { SendResult } from '@qqbot/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildSession, type Sender } from './session.js'

const ok: SendResult = { ok: true, status: 200, messageId: 'stream-1', raw: {} }
const failed: SendResult = { ok: false, status: 503, error: '暂不可用', raw: {} }

function setup(scene: 'c2c' | 'group' = 'c2c', limit = 5) {
  const send = vi.fn<NonNullable<Sender['streamChunk']>>(async () => ok)
  const reply = vi.fn<Sender['sendMessage']>(async () => ok)
  const recall = vi.fn<NonNullable<Sender['recallMessage']>>(async () => true)
  const session = buildSession({
    op: 0, id: 'event-1', t: scene === 'c2c' ? 'C2C_MESSAGE_CREATE' : 'GROUP_MESSAGE_CREATE',
    d: { id: 'incoming', author: { user_openid: 'U' }, ...(scene === 'group' ? { group_openid: 'G' } : {}) },
  }, { botId: 'bot', sender: { sendMessage: reply, streamChunk: send, recallMessage: recall }, maxPassiveReplies: limit })
  return { session, send, reply, recall }
}

afterEach(() => vi.useRealTimers())

describe('流式发送状态与缓冲', () => {
  it('首片立即发，短分片在 500ms 合并，空尾仍有结束帧', async () => {
    vi.useFakeTimers()
    const { session, send, recall } = setup()
    const writer = session.stream()
    expect((await writer.write('你')).status).toBe(200)
    expect(await writer.write('好')).toMatchObject({ ok: true, status: 0 })
    await writer.write('！')
    await vi.advanceTimersByTimeAsync(499)
    expect(send).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(send.mock.calls.map(([, text]) => text)).toEqual(['你', '好！'])
    await writer.end()
    expect(send.mock.calls.map(([, , opts]) => opts)).toEqual([
      { messageId: 'incoming', msgSeq: 1, index: 0, final: false },
      { messageId: 'incoming', msgSeq: 1, index: 1, final: false, streamId: 'stream-1' },
      { messageId: 'incoming', msgSeq: 1, index: 2, final: true, streamId: 'stream-1' },
    ])
    expect(send.mock.calls[2]![1]).toBe('')
    expect(writer.messageId).toBe('stream-1')
    expect(vi.getTimerCount()).toBe(0)
    await session.recall()
    expect(recall).toHaveBeenCalledWith({ scene: 'c2c', id: 'U' }, 'stream-1')
  })

  it('多个分片只占一条回复额度；新的流仍受额度限制', async () => {
    vi.useFakeTimers()
    const { session, send } = setup()
    const writer = session.stream()
    for (const part of ['a', 'b', 'c', 'd', 'e']) {
      await writer.write(part)
      await vi.advanceTimersByTimeAsync(500)
    }
    await writer.end('f')
    expect(send).toHaveBeenCalledTimes(6)
    expect(new Set(send.mock.calls.map(([, , o]) => o.msgSeq))).toEqual(new Set([1]))
    for (let i = 0; i < 4; i++) expect((await session.reply('补充')).ok).toBe(true)
    expect((await session.reply('超额')).ok).toBe(false)
    expect((await session.stream().end('另一个流')).ok).toBe(false)
    expect(send).toHaveBeenCalledTimes(6)
  })

  it('并发 write/end 等首片完成再发合并尾片；重复 end 和关闭后 write 不再发请求', async () => {
    const { session, send } = setup()
    let finish!: (value: SendResult) => void
    send.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const writer = session.stream()
    const first = writer.write('A')
    await writer.write('B')
    await writer.write('C')
    const end = writer.end('D')
    expect(writer.end('不要重复')).toBe(end)
    expect((await writer.write('结束后')).ok).toBe(false)
    expect(send).toHaveBeenCalledTimes(1)
    finish(ok)
    await first
    expect(await end).toEqual(ok)
    expect(send.mock.calls.map(([, text, options]) => [text, options.index, options.final])).toEqual([
      ['A', 0, false], ['BCD', 1, true],
    ])
  })

  it('首片失败后保留失败结果，不跳号继续发送，也不额外发结束片', async () => {
    const { session, send } = setup()
    send.mockResolvedValueOnce(failed)
    const writer = session.stream()
    expect(await writer.write('A')).toEqual(failed)
    expect(await writer.write('B')).toEqual(failed)
    expect(await writer.end()).toEqual(failed)
    expect(send).toHaveBeenCalledTimes(1)
    expect(writer.messageId).toBeUndefined()
  })

  it('定时 flush 抛错也能被 end 观察到，并停止未发出的内容', async () => {
    vi.useFakeTimers()
    const { session, send } = setup()
    const writer = session.stream()
    await writer.write('A')
    send.mockRejectedValueOnce(new Error('网络中断'))
    await writer.write('B')
    await vi.advanceTimersByTimeAsync(500)
    expect(await writer.end('C')).toMatchObject({ ok: false, error: '网络中断' })
    expect(send).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('成功响应缺少首片 ID 时停止，不能发出没有 streamId 的续片', async () => {
    const { session, send } = setup()
    send.mockResolvedValueOnce({ ok: true, status: 200, raw: {} })
    const writer = session.stream()
    expect(await writer.write('A')).toMatchObject({ ok: false, error: expect.stringContaining('消息 ID') })
    expect((await writer.end('B')).ok).toBe(false)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('空流不发送、不占额度；仅 end 有正文时按单个结束片发送', async () => {
    const { session, send } = setup('c2c', 1)
    const empty = session.stream()
    await empty.write('')
    await empty.end()
    expect(send).not.toHaveBeenCalled()
    await session.stream().end('完整回复')
    expect(send.mock.calls[0]).toEqual(['U', '完整回复', { messageId: 'incoming', msgSeq: 1, index: 0, final: true }])
  })

  it('群聊汇总成一次回复，每个 writer 的缓冲互不串用', async () => {
    const { session, send, reply } = setup('group')
    const a = session.stream()
    const b = session.stream()
    await a.write('A')
    await b.write('B')
    await a.end('1')
    await a.end('不重复')
    await b.end('2')
    expect((await a.write('已关闭')).ok).toBe(false)
    expect(reply.mock.calls.map(([, text]) => text)).toEqual(['A1', 'B2'])
    expect(send).not.toHaveBeenCalled()
  })
})
