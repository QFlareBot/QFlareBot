import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBindTask, pollBindResult } from './bind.js'
import { QQBotClient } from './client.js'
import type { TokenProvider } from './token.js'

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers })
const tokens = (): TokenProvider => ({ get: async () => 'token', invalidate: async () => {} })
function client(fetchImpl: typeof fetch, tokenProvider = tokens()) {
  return new QQBotClient({ appId: 'bot', secret: 'secret', fetchImpl, tokenProvider })
}
const target = { scene: 'c2c', id: 'U' } as const
const passive = { messageId: 'M', msgSeq: 3 }
type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>
const body = (fetch: FetchMock, index: number) => JSON.parse(String(fetch.mock.calls[index]![1]!.body)) as Record<string, unknown>

afterEach(() => vi.useRealTimers())

describe('有限重试与错误保留', () => {
  it('401 刷新 token 后重放同一请求，持续 401 只刷新一次', async () => {
    let token = 'old'
    const provider = { get: async () => token, invalidate: vi.fn(async () => { token = 'new' }) }
    const fetch = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ code: 11243 }, 401)).mockResolvedValueOnce(json({ id: 'sent' }))
    expect((await client(fetch, provider).sendMessage(target, 'hi', passive)).ok).toBe(true)
    expect(provider.invalidate).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls.map(([, init]) => (init!.headers as Record<string, string>).authorization)).toEqual(['QQBot old', 'QQBot new'])
    expect(body(fetch, 1)).toEqual(body(fetch, 0))

    fetch.mockReset().mockImplementation(async () => json({ code: 11243 }, 401))
    provider.invalidate.mockClear()
    expect((await client(fetch, provider).sendMessage(target, 'hi', passive)).ok).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(provider.invalidate).toHaveBeenCalledTimes(1)
  })

  it('被动回复临时失败重试一次，msg_id/event_id 和序号保持不变', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(json({ id: 'sent' }))
    const result = client(fetch).sendMessage(target, 'hi', { eventId: 'E', msgSeq: 4 })
    await vi.advanceTimersByTimeAsync(250)
    expect((await result).ok).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(body(fetch, 1)).toEqual({ msg_type: 0, content: 'hi', event_id: 'E', msg_seq: 4 })
    expect(body(fetch, 0)).toEqual(body(fetch, 1))
  })

  it('读取接口只重试一次，权限/限流/配额错误直接返回', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn<typeof fetch>(async () => json({ message: 'temporary' }, 503))
    const result = client(fetch).raw('GET', '/users/@me')
    await vi.advanceTimersByTimeAsync(250)
    expect((await result).status).toBe(503)
    expect(fetch).toHaveBeenCalledTimes(2)
    for (const [status, code] of [[403, 11253], [429, 50002], [500, 40093002]]) {
      fetch.mockClear().mockImplementation(async () => json({ code }, status))
      expect((await client(fetch).sendMessage(target, 'hi', passive)).ok).toBe(false)
      expect(fetch).toHaveBeenCalledTimes(1)
    }
  })

  it('主动发送、append 流和通用写操作遇到结果不明时不重放', async () => {
    const fetch = vi.fn<typeof fetch>(async () => { throw new TypeError('network reset') })
    const api = client(fetch)
    expect((await api.sendMessage(target, 'active')).ok).toBe(false)
    expect((await api.streamChunk('U', 'delta', { ...passive, index: 0, final: false })).ok).toBe(false)
    await expect(api.raw('POST', '/v2/panels', {})).rejects.toThrow('network reset')
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('媒体上传失败保留原始状态、业务错误码、响应体与 header traceId', async () => {
    const error = { err_code: '11253', message: 'forbidden' }
    const fetch = vi.fn<typeof fetch>(async () => json(error, 403, { 'X-Tps-trace-ID': 'trace-1' }))
    const result = await client(fetch).sendMessage(target, { image: { base64: 'AAAA' } }, passive)
    expect(result).toMatchObject({ ok: false, status: 403, code: 11253, traceId: 'trace-1', raw: error })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('HTTP 成功但业务错误时，结果型与抛错型接口都报告失败', async () => {
    const error = { err_code: 11253, trace_id: 'trace-body', message: 'forbidden' }
    const fetch = vi.fn<typeof fetch>(async () => json(error))
    const api = client(fetch)
    expect(await api.sendMessage(target, 'hi')).toMatchObject({ ok: false, status: 200, code: 11253, traceId: 'trace-body' })
    await expect(api.group.info('G')).rejects.toMatchObject({ name: 'QQApiError', code: 11253, traceId: 'trace-body', body: error })
  })

  it('HTTP 200 但缺少 token/file_info 时仍为失败，保留原始响应', async () => {
    const fetch = vi.fn<typeof fetch>(async () => json({ unexpected: true }))
    const media = await client(fetch).sendMessage(target, { image: { base64: 'AAAA' } })
    expect(media).toMatchObject({ ok: false, status: 200, raw: { unexpected: true }, error: expect.stringContaining('file_info') })
    const api = new QQBotClient({ appId: 'malformed-token', secret: 'secret', fetchImpl: fetch })
    expect((await api.sendMessage(target, 'hi')).ok).toBe(false)
    expect(await api.ackInteraction('I')).toBe(false)
    expect(await api.recallMessage(target, 'M')).toBe(false)
  })
})

describe('请求期限', () => {
  it('网络挂起 8 秒后取消，主动发送不自动重放', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const fetch = vi.fn<typeof fetch>(async (_url, init) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>((_, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }))
    })
    const result = client(fetch).sendMessage(target, 'hi')
    await vi.advanceTimersByTimeAsync(8_000)
    expect(await result).toMatchObject({ ok: false, status: 0, error: 'QQ API 请求超时' })
    expect(signal?.aborted).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('token 卡住也会超时，晚到的 token 不会触发迟到的发送', async () => {
    vi.useFakeTimers()
    let resolve!: (token: string) => void
    const provider = { get: () => new Promise<string>((done) => { resolve = done }), invalidate: async () => {} }
    const fetch = vi.fn<typeof fetch>(async () => json({ id: 'sent' }))
    const result = client(fetch, provider).sendMessage(target, 'hi')
    await vi.advanceTimersByTimeAsync(8_000)
    expect((await result).ok).toBe(false)
    resolve('late-token')
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('响应 body 未读完也受超时限制', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn<typeof fetch>(async (_url, init) => new Response(new ReadableStream({
      start(controller) { init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason), { once: true }) },
    })))
    const result = client(fetch).sendMessage(target, 'hi')
    await vi.advanceTimersByTimeAsync(8_000)
    expect(await result).toMatchObject({ ok: false, error: 'QQ API 请求超时' })
  })

  it('上传、上传重试和发送共用 20 秒预算', async () => {
    vi.useFakeTimers()
    let count = 0
    const fetch = vi.fn<typeof fetch>(async (_url, init) => new Promise<Response>((resolve, reject) => {
      const call = ++count
      const timer = setTimeout(() => resolve(call === 1 ? json({}, 503) : call === 2 ? json({ file_info: 'FI' }) : json({ id: 'sent' })), 7_000)
      init!.signal!.addEventListener('abort', () => { clearTimeout(timer); reject(init!.signal!.reason) }, { once: true })
    }))
    const result = client(fetch).sendMessage(target, { image: { url: 'https://example.test/a.png' } }, passive)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await result).toMatchObject({ ok: false, error: 'QQ API 请求超时' })
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('原生 Markdown 降级', () => {
  it.each([{ code: 50056, message: 'denied' }, { message: '不允许发送原生 markdown' }])('明确拒绝后用纯文本重试，保留回复和引用凭据：%j', async (denial) => {
    const fetch = vi.fn<typeof fetch>().mockResolvedValueOnce(json(denial, 500)).mockResolvedValueOnce(json({ id: 'sent' }))
    const result = await client(fetch).sendMessage(target, { markdown: { content: '**内容**' }, text: '纯文本内容', quote: 'REFIDX_1' }, passive)
    expect(result.ok).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(body(fetch, 1)).toEqual({ msg_type: 0, content: '纯文本内容', message_reference: { message_id: 'REFIDX_1' }, msg_id: 'M', msg_seq: 3 })
    expect(body(fetch, 0).markdown).toEqual({ content: '**内容**' })
  })

  it('频道降级不混入 v2 msg_type，保留 event_id', async () => {
    const fetch = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ err_code: 50056 }, 403)).mockResolvedValueOnce(json({ id: 'sent' }))
    await client(fetch).sendMessage({ scene: 'guild', id: 'C' }, { markdown: { content: '正文' } }, { eventId: 'E' })
    expect(body(fetch, 1)).toEqual({ content: '正文', event_id: 'E' })
  })

  it('按钮、模板、空正文与其他权限拒绝不做内容降级', async () => {
    const fetch = vi.fn<typeof fetch>(async () => json({ code: 50056 }, 403))
    const api = client(fetch)
    await api.sendMessage(target, { text: '选项', keyboard: { content: { rows: [] } } }, passive)
    await api.sendMessage(target, { markdown: { customTemplateId: 'T', content: '正文' } }, passive)
    await api.sendMessage(target, { markdown: { content: '' } }, passive)
    fetch.mockImplementation(async () => json({ code: 11253, message: 'forbidden' }, 403))
    await api.sendMessage(target, { markdown: { content: '正文' } }, passive)
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('降级再次失败即返回错误，不改成主动发送', async () => {
    const fetch = vi.fn<typeof fetch>(async () => json({ code: 50056 }, 403))
    expect((await client(fetch).sendMessage(target, { markdown: { content: '正文' } }, passive)).ok).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(body(fetch, 1)).toMatchObject({ msg_id: 'M', msg_seq: 3 })
  })
})

it('扫码创建不重试创建操作；只读轮询可以有限重试', async () => {
  vi.useFakeTimers()
  const fetch = vi.fn<typeof fetch>(async () => json({}, 503))
  await expect(createBindTask({ fetchImpl: fetch })).rejects.toThrow('503')
  expect(fetch).toHaveBeenCalledTimes(1)
  fetch.mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(json({ data: { status: 1 } }))
  const result = pollBindResult('task', 'key', { fetchImpl: fetch })
  await vi.advanceTimersByTimeAsync(250)
  expect(await result).toEqual({ status: 'pending' })
  expect(fetch).toHaveBeenCalledTimes(3)
})
