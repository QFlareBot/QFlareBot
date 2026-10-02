/**
 * msg_seq 由 Session 集中分配：同一条消息下重复的序号会被平台拒收。
 * typing（输入中）也要带被动凭据，以前没给序号、客户端默认填 1，正好撞上第一条回复。
 */
import type { WebhookPayload } from '@qqbot/api'
import type { SendOptions, SendResult } from '@qqbot/sdk'
import { describe, expect, it } from 'vitest'
import { buildSession, type Sender } from './session.js'

const OK: SendResult = { ok: true, status: 200, raw: null }

type Kind = 'reply' | 'typing' | 'stream'

function setup(payload: WebhookPayload) {
  const calls: Array<{ kind: Kind; options: SendOptions | undefined }> = []
  const record = (kind: Kind, options: SendOptions | undefined) => {
    calls.push({ kind, options })
    return { ...OK, messageId: 'sent' }
  }
  const sender: Sender = {
    sendMessage: async (_t, _m, options) => record('reply', options),
    typing: async (_u, _s, options) => record('typing', options),
    streamChunk: async (_u, _c, options) => record('stream', options),
  }
  return { session: buildSession(payload, { botId: 'b', sender, maxPassiveReplies: 5 }), calls }
}

const c2cMessage: WebhookPayload = {
  op: 0,
  id: 'C2C_MESSAGE_CREATE:e1',
  t: 'C2C_MESSAGE_CREATE',
  d: { id: 'm1', content: 'hi', author: { user_openid: 'U1' } },
}

describe('session.typing 的 msg_seq', () => {
  it('typing 从同一个计数器取号，第一条回复不再撞 1', async () => {
    const { session, calls } = setup(c2cMessage)
    await session.typing(5)
    await session.reply('好了')
    expect(calls).toEqual([
      { kind: 'typing', options: { messageId: 'm1', msgSeq: 1 } },
      { kind: 'reply', options: { messageId: 'm1', msgSeq: 2 } },
    ])
  })

  it('typing 不占被动回复上限：前面 typing 过，照样能回满 5 条', async () => {
    const { session, calls } = setup(c2cMessage)
    await session.typing()
    await session.typing()
    const results = []
    for (let i = 0; i < 6; i++) results.push(await session.reply(`第 ${i + 1} 条`))
    expect(results.map((r) => r.ok)).toEqual([true, true, true, true, true, false])
    expect(results[5]!.error).toContain('上限 5')
    expect(calls.filter((c) => c.kind === 'reply').map((c) => c.options?.msgSeq)).toEqual([3, 4, 5, 6, 7])
  })

  it('一个流占一个序号，与 typing、普通回复不撞号', async () => {
    const { session, calls } = setup(c2cMessage)
    await session.typing()
    const w = session.stream()
    await w.write('你')
    await w.end('好')
    await session.reply('补一句')
    expect(calls.map((c) => [c.kind, c.options?.msgSeq])).toEqual([
      ['typing', 1],
      ['stream', 2],
      ['stream', 2],
      ['reply', 3],
    ])
  })

  it('凭 event_id 也照样取号；没有被动凭据时照旧不带序号', async () => {
    const friend = setup({ op: 0, id: 'FRIEND_ADD:e2', t: 'FRIEND_ADD', d: { openid: 'U1', timestamp: 0 } })
    await friend.session.typing()
    expect(friend.calls.map((c) => c.options)).toEqual([{ eventId: 'FRIEND_ADD:e2', msgSeq: 1 }])

    // 没有消息 id，也不是可凭 event_id 回复的事件
    const bare = setup({ op: 0, id: 'C2C_MESSAGE_CREATE:e3', t: 'C2C_MESSAGE_CREATE', d: { author: { user_openid: 'U1' } } })
    await bare.session.typing()
    expect(bare.calls.map((c) => c.options)).toEqual([{}])
  })

  it('群聊里 typing 仍然直接失败，不消耗序号', async () => {
    const { session, calls } = setup({
      op: 0,
      id: 'GROUP_AT_MESSAGE_CREATE:e4',
      t: 'GROUP_AT_MESSAGE_CREATE',
      d: { id: 'm4', content: 'hi', author: { member_openid: 'U1' }, group_openid: 'G1' },
    })
    expect((await session.typing()).ok).toBe(false)
    await session.reply('hi')
    expect(calls).toEqual([{ kind: 'reply', options: { messageId: 'm4', msgSeq: 1 } }])
  })
})
