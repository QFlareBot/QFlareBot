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
    expect(url).toBe('https://api.sgroup.qq.com/v2/groups/G1/messages')
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
