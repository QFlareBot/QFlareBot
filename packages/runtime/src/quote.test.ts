import { describe, expect, it } from 'vitest'
import type { RawMessageEvent } from '@qqbot/api'
import { buildQuote } from './quote.js'
import { buildSession } from './session.js'

const msg = (d: Partial<RawMessageEvent>): RawMessageEvent => ({ id: 'm', content: 'answer', ...d })

describe('buildQuote（session.quote）', () => {
  it('引用消息：id、原文、附件、被引用消息的 ref index 都读出来', () => {
    const quote = buildQuote(
      msg({
        message_type: 103,
        message_reference: { message_id: 'quoted-1' },
        msg_elements: [
          { content: '<@BOT> 原文 ', attachments: [{ url: 'img.example.com/q.png', content_type: 'image/png', filename: 'q.png' }] },
        ],
        message_scene: { ext: ['msg_idx=REFIDX_self', 'ref_msg_idx=REFIDX_quoted'] },
      }),
    )
    expect(quote).toEqual({
      messageId: 'quoted-1',
      content: '<@BOT> 原文 ',
      attachments: [{ url: 'https://img.example.com/q.png', contentType: 'image/png', filename: 'q.png' }],
      refIndex: 'REFIDX_quoted',
    })
  })

  it('没有 message_reference 时 id 取 msg_elements[0] 的 id / message_id', () => {
    expect(buildQuote(msg({ message_type: 103, msg_elements: [{ id: 'e1' }] }))?.messageId).toBe('e1')
    expect(buildQuote(msg({ message_type: '103' as unknown as number, msg_elements: [{ message_id: 'e2' }] }))?.messageId).toBe('e2')
  })

  it('不是 103 就不读 msg_elements；只有 message_reference 或 ref_msg_idx 也算引用', () => {
    expect(buildQuote(msg({ message_type: 0, msg_elements: [{ id: 'e1', content: 'x' }] }))).toBeUndefined()
    expect(buildQuote(msg({ message_reference: { message_id: 'r1' } }))).toEqual({
      messageId: 'r1',
      content: '',
      attachments: [],
      refIndex: undefined,
    })
    expect(buildQuote(msg({ message_scene: { ext: ['ref_msg_idx=REFIDX_q'] } }))).toMatchObject({ messageId: '', refIndex: 'REFIDX_q' })
  })

  it('没引用、形状不对都是 undefined，不抛', () => {
    expect(buildQuote(msg({}))).toBeUndefined()
    expect(buildQuote(msg({ message_scene: { ext: ['msg_idx=REFIDX_self'] } }))).toBeUndefined()
    expect(buildQuote(msg({ message_type: 103, msg_elements: 'x' as never }))).toBeUndefined()
    expect(buildQuote(msg({ message_type: 103, msg_elements: [null as never] }))).toBeUndefined()
  })

  it('挂在 session 上', () => {
    const sender = { sendMessage: async () => ({ ok: true, status: 200, raw: null }) }
    const session = buildSession(
      {
        op: 0,
        id: 'x',
        t: 'GROUP_AT_MESSAGE_CREATE',
        d: { id: 'm', content: '撤回', group_openid: 'G1', author: { member_openid: 'U1' }, message_reference: { message_id: 'q1' } },
      },
      { botId: 'b', sender, maxPassiveReplies: 5 },
    )
    expect(session.quote?.messageId).toBe('q1')
    expect(session.refIndex).toBeUndefined()
  })
})
