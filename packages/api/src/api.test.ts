import { describe, expect, it, vi } from 'vitest'
import { signCallback, verifyEvent, getKeyPair, bytesToHex } from './crypto.js'
import { createTokenProvider, memoryTokenCache } from './token.js'
import { QQBotClient } from './client.js'

const SECRET = 'DG5g3B4j9X2KOErG'

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('crypto', () => {
  it('回调签名可用派生公钥验证', async () => {
    const ts = '1789651239'
    const token = 'abc123'
    const sigHex = await signCallback(SECRET, ts, token)
    expect(sigHex).toHaveLength(128)

    const { publicKey } = await getKeyPair(SECRET)
    const ok = await crypto.subtle.verify(
      { name: 'Ed25519' },
      publicKey,
      Uint8Array.from(sigHex.match(/../g)!.map((h) => parseInt(h, 16))),
      new TextEncoder().encode(ts + token),
    )
    expect(ok).toBe(true)
  })

  it('事件验签：正确签名通过，篡改 body 失败', async () => {
    const ts = '1789651239'
    const body = '{"op":0,"t":"C2C_MESSAGE_CREATE"}'
    const { privateKey } = await getKeyPair(SECRET)
    const sig = bytesToHex(
      await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, new TextEncoder().encode(ts + body)),
    )
    expect(await verifyEvent(SECRET, ts, body, sig)).toBe(true)
    expect(await verifyEvent(SECRET, ts, body + ' ', sig)).toBe(false)
    expect(await verifyEvent(SECRET, ts, body, 'zz')).toBe(false)
  })
})

describe('token', () => {
  it('缓存有效期内不重复请求，并发请求合并', async () => {
    const fetchMock: FetchMock = vi.fn(async () => jsonResponse({ access_token: 'tok', expires_in: 7200 }))
    const provider = createTokenProvider({ appId: 'a', secret: 's', fetchImpl: fetchMock, cache: memoryTokenCache() })
    const [t1, t2] = await Promise.all([provider.get(), provider.get()])
    expect(t1).toBe('tok')
    expect(t2).toBe('tok')
    await provider.get()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('凭证错误抛 QQApiError', async () => {
    const fetchMock: FetchMock = vi.fn(async () => jsonResponse({ code: 10001, message: 'invalid appid' }, 400))
    const provider = createTokenProvider({ appId: 'a', secret: 's', fetchImpl: fetchMock })
    await expect(provider.get()).rejects.toMatchObject({ name: 'QQApiError', status: 400, code: 10001 })
  })
})

describe('QQBotClient.sendMessage', () => {
  function makeClient(fetchMock: FetchMock) {
    return new QQBotClient({
      appId: 'app',
      secret: 's',
      fetchImpl: fetchMock,
      tokenProvider: { get: async () => 'tok', invalidate: async () => {} },
    })
  }

  it('群聊被动文本回复：带 msg_id 与 msg_seq', async () => {
    const fetchMock: FetchMock = vi.fn(async () => jsonResponse({ id: 'reply-1' }))
    const client = makeClient(fetchMock)
    const result = await client.sendMessage({ scene: 'group', id: 'G1' }, '你好', { messageId: 'M1', msgSeq: 2 })

    expect(result).toMatchObject({ ok: true, status: 200, messageId: 'reply-1' })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.bot.qq.com/v2/groups/G1/messages')
    expect((init!.headers as Record<string, string>).authorization).toBe('QQBot tok')
    expect(JSON.parse(init!.body as string)).toEqual({ msg_type: 0, content: '你好', msg_id: 'M1', msg_seq: 2 })
  })

  it('单聊图片：先上传 /files 再以 msg_type 7 发送', async () => {
    const fetchMock: FetchMock = vi.fn(async (input) => {
      const url = String(input)
      if (url.endsWith('/files')) return jsonResponse({ file_info: 'FI', file_uuid: 'U', ttl: 86400 })
      return jsonResponse({ id: 'reply-2' })
    })
    const client = makeClient(fetchMock)
    const result = await client.sendMessage({ scene: 'c2c', id: 'U1' }, { image: { base64: 'AAAA' } })

    expect(result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
      file_type: 1,
      file_data: 'AAAA',
      srv_send_msg: false,
    })
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)).toMatchObject({ msg_type: 7, media: { file_info: 'FI' } })
  })

  it('接口报错时返回 ok=false 与错误信息', async () => {
    const fetchMock: FetchMock = vi.fn(async () => jsonResponse({ message: '主动消息失败, 无权限', code: 40034 }, 400))
    const result = await makeClient(fetchMock).sendMessage({ scene: 'group', id: 'G1' }, 'x')
    expect(result).toMatchObject({ ok: false, status: 400, error: '主动消息失败, 无权限' })
  })
})

describe('QQBotClient 扩展能力', () => {
  function makeClient(fetchMock: FetchMock) {
    return new QQBotClient({
      appId: 'app',
      secret: 's',
      fetchImpl: fetchMock,
      tokenProvider: { get: async () => 'tok', invalidate: async () => {} },
    })
  }
  const body = (m: FetchMock, i = 0) => JSON.parse(m.mock.calls[i]![1]!.body as string)
  const url = (m: FetchMock, i = 0) => String(m.mock.calls[i]![0])

  it('带键盘的文本自动升级为 markdown 消息', async () => {
    const f: FetchMock = vi.fn(async () => jsonResponse({ id: 'x' }))
    await makeClient(f).sendMessage({ scene: 'c2c', id: 'U' }, { text: '选一个', keyboard: { content: { rows: [] } } }, { messageId: 'M' })
    expect(body(f)).toEqual({ msg_type: 2, markdown: { content: '选一个' }, keyboard: { content: { rows: [] } }, msg_id: 'M', msg_seq: 1 })
  })

  it('event_id 被动回复、引用与 wakeup', async () => {
    const f: FetchMock = vi.fn(async () => jsonResponse({ id: 'x', ext_info: { ref_idx: 'REFIDX_1' } }))
    const c = makeClient(f)
    const r = await c.sendMessage({ scene: 'group', id: 'G' }, { text: 'hi', quote: 'REFIDX_0' }, { eventId: 'GROUP_ADD_ROBOT:1' })
    expect(body(f)).toEqual({ msg_type: 0, content: 'hi', message_reference: { message_id: 'REFIDX_0' }, event_id: 'GROUP_ADD_ROBOT:1', msg_seq: 1 })
    expect(r.refIndex).toBe('REFIDX_1')
    await c.sendMessage({ scene: 'c2c', id: 'U' }, 'wake', { wakeup: true, messageId: 'ignored' })
    expect(body(f, 1)).toEqual({ msg_type: 0, content: 'wake', is_wakeup: true })
  })

  it('视频等媒体按 file_type 上传并携带 file_name', async () => {
    const f: FetchMock = vi.fn(async (input) =>
      String(input).endsWith('/files') ? jsonResponse({ file_info: 'FI', ttl: 0 }) : jsonResponse({ id: 'x' }),
    )
    await makeClient(f).sendMessage({ scene: 'group', id: 'G' }, { media: { type: 'video', url: 'https://a/b.mp4', filename: 'b.mp4' } })
    expect(body(f)).toEqual({ file_type: 2, srv_send_msg: false, url: 'https://a/b.mp4', file_name: 'b.mp4' })
    expect(body(f, 1)).toMatchObject({ msg_type: 7, media: { file_info: 'FI' } })
  })

  it('typing / stream / recall / ack 走正确端点', async () => {
    const f: FetchMock = vi.fn(async () => jsonResponse({ id: 'S1' }))
    const c = makeClient(f)
    await c.typing('U', 99, { messageId: 'M' })
    expect(body(f)).toEqual({ msg_type: 6, input_notify: { input_type: 1, input_second: 60 }, msg_id: 'M', msg_seq: 1 })

    const first = await c.streamChunk('U', '你', { index: 0, final: false, messageId: 'M' })
    expect(url(f, 1)).toContain('/v2/users/U/stream_messages')
    expect(body(f, 1)).toEqual({ input_mode: 'append', input_state: 1, index: 0, content_type: 'text', content_raw: '你', msg_id: 'M', msg_seq: 1 })
    await c.streamChunk('U', '好', { index: 1, final: true, messageId: 'M', streamId: first.messageId!, msgSeq: 2 })
    expect(body(f, 2)).toMatchObject({ input_state: 10, index: 1, stream_msg_id: 'S1', msg_seq: 2 })

    expect(await c.recallMessage({ scene: 'group', id: 'G' }, 'MID')).toBe(true)
    expect(f.mock.calls[3]![1]!.method).toBe('DELETE')
    expect(url(f, 3)).toBe('https://api.bot.qq.com/v2/groups/G/messages/MID')

    expect(await c.ackInteraction('I1', 4)).toBe(true)
    expect(f.mock.calls[4]![1]!.method).toBe('PUT')
    expect(url(f, 4)).toBe('https://api.bot.qq.com/interactions/I1')
    expect(body(f, 4)).toEqual({ code: 4 })
  })

  it('群管理：禁言、审批、移除按文档字段发送', async () => {
    const f: FetchMock = vi.fn(async () => jsonResponse({ remove_members_result: 'success', add_to_member_blacklist_fail_openids: ['x'] }))
    const g = makeClient(f).group
    await g.mute('G', [{ op: 'add', memberOpenid: 'M1', expireAt: '2026-09-19T00:00:00+08:00' }, { op: 'del', memberOpenid: 'M2' }])
    expect(body(f)).toEqual({ members: [{ op: 'add', member_openid: 'M1', mute_expire_at: '2026-09-19T00:00:00+08:00' }, { op: 'del', member_openid: 'M2', mute_expire_at: '' }] })

    await g.reviewJoinRequest('G', 'M1', { approve: false, reason: '不符合', addToBlacklist: true }, 'JR1')
    expect(url(f, 1)).toContain('/v2/groups/G/approval_join_request/M1')
    expect(body(f, 1)).toEqual({ op: 'decline', join_request_id: 'JR1', reject_reason: '不符合', add_to_member_blacklist: true })

    const r = await g.removeMembers('G', ['M1'], { addToBlacklist: true })
    expect(body(f, 2)).toEqual({ member_openids: ['M1'], add_to_member_blacklist: true })
    expect(r.failedBlacklist).toEqual(['x'])
    await expect(g.removeMembers('G', new Array(21).fill('x'))).rejects.toThrow('20')
  })

  it('群管理接口报错抛 QQApiError', async () => {
    const f: FetchMock = vi.fn(async () => jsonResponse({ code: 11253, message: '应用无接口访问权限' }, 403))
    await expect(makeClient(f).group.members('G')).rejects.toMatchObject({ name: 'QQApiError', status: 403, code: 11253 })
  })
})

describe('结果型方法不抛异常', () => {
  it('token 获取失败时 sendMessage 返回 ok=false 而不是抛错', async () => {
    const f: FetchMock = vi.fn(async () => jsonResponse({ code: 10001, message: 'invalid appid or secret' }, 400))
    const c = new QQBotClient({ appId: 'a', secret: 's', fetchImpl: f })
    const r = await c.sendMessage({ scene: 'group', id: 'G' }, 'x')
    expect(r).toMatchObject({ ok: false, status: 0, error: 'invalid appid or secret' })
    expect(await c.ackInteraction('I')).toBe(false)
    expect(await c.recallMessage({ scene: 'group', id: 'G' }, 'M')).toBe(false)
  })
})
