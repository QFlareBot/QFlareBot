import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBridge } from './index.js'
import { CHANNEL } from './protocol.js'

function setup() {
  const parent = { postMessage: vi.fn() }
  const win = Object.assign(new EventTarget(), { parent })
  vi.stubGlobal('window', win)
  vi.stubGlobal('location', { pathname: '/p/foo/ui/', search: '?token=from-url' })
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  vi.stubGlobal('document', { documentElement: { dataset: {} }, readyState: 'complete', title: '' })
  const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}'))
  vi.stubGlobal('fetch', fetchSpy)
  const send = (data: unknown, source: unknown = parent) => win.dispatchEvent(Object.assign(new Event('message'), { data, source }))
  const init = (nonce: string, token: string, base = '/p/foo') =>
    ({ channel: CHANNEL, type: 'init', nonce, token, theme: 'dark', plugin: 'foo', base }) as const
  /** 当前 fetch 带出去的令牌 */
  const tokenOf = async (bridge: Awaited<ReturnType<typeof createBridge>>) => {
    await bridge.fetch('/api/x')
    return new Headers(fetchSpy.mock.calls.at(-1)![1]!.headers).get('authorization')
  }
  return { parent, send, init, tokenOf, fetchSpy }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createBridge（页面端）', () => {
  it('向面板发 ready，只认 window.parent 发来的 init', async () => {
    const s = setup()
    const pending = createBridge({ timeout: 50 })
    expect(s.parent.postMessage).toHaveBeenCalledWith({ channel: CHANNEL, type: 'ready' }, '*')

    // 页面里嵌的别的 iframe / 弹窗伪造的 init：不理
    s.send(s.init('evil', 'evil-token', '/p/evil'), { postMessage() {} })
    s.send(s.init('n1', 'bridge-token'))
    const bridge = await pending
    expect(bridge.embedded).toBe(true)
    expect(bridge.base).toBe('/p/foo')
    expect(await s.tokenOf(bridge)).toBe('Bearer bridge-token')
    expect(s.fetchSpy.mock.calls.at(-1)![0]).toBe('/p/foo/api/x')
  })

  it('init 只认第一次；之后的 token 刷新照常生效', async () => {
    const s = setup()
    const pending = createBridge({ timeout: 50 })
    s.send(s.init('n1', 'first'))
    const bridge = await pending

    s.send(s.init('n2', 'second', '/p/other'))
    expect(bridge.base).toBe('/p/foo')
    expect(await s.tokenOf(bridge)).toBe('Bearer first')

    s.send({ channel: CHANNEL, type: 'token', nonce: 'n2', token: 'wrong-nonce' })
    s.send({ channel: CHANNEL, type: 'token', nonce: 'n1', token: 'refreshed' })
    expect(await s.tokenOf(bridge)).toBe('Bearer refreshed')
  })

  it('同一个页面多次调用共用一次握手：面板每次加载只应答一次 ready', async () => {
    const s = setup()
    const first = createBridge({ timeout: 50 })
    const second = createBridge({ timeout: 50 })
    expect(second).toBe(first)
    expect(s.parent.postMessage).toHaveBeenCalledTimes(1)
    s.send(s.init('n1', 'shared'))
    expect(await s.tokenOf(await second)).toBe('Bearer shared')
  })

  it('没有面板应答时按独立模式工作，令牌取地址里的 ?token=', async () => {
    const s = setup()
    const bridge = await createBridge({ timeout: 10 })
    expect(bridge.embedded).toBe(false)
    expect(await s.tokenOf(bridge)).toBe('Bearer from-url')
  })
})
