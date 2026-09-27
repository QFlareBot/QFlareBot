import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachBridgeHost, type HostOptions } from './host.js'
import { CHANNEL, type HostMessage } from './protocol.js'

/** 让 await getToken() 之后的代码跑完 */
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

function setup(overrides: Partial<HostOptions> = {}) {
  const win = new EventTarget()
  vi.stubGlobal('window', win)
  const posted: HostMessage[] = []
  const contentWindow = { postMessage: (msg: HostMessage) => posted.push(msg) }
  const iframe = Object.assign(new EventTarget(), { contentWindow }) as unknown as HTMLIFrameElement
  let n = 0
  const getToken = vi.fn(async () => `t${++n}`)
  const host = attachBridgeHost({ iframe, plugin: 'foo', base: '/p/foo', theme: 'light', getToken, refreshMs: 1000, ...overrides })
  const message = (data: unknown, source: unknown = contentWindow) => win.dispatchEvent(Object.assign(new Event('message'), { data, source }))
  return {
    host,
    getToken,
    posted,
    /** iframe 里的文档发 ready */
    ready: async (source: unknown = contentWindow) => {
      message({ channel: CHANNEL, type: 'ready' }, source)
      await flush()
    },
    message,
    load: () => iframe.dispatchEvent(new Event('load')),
    inits: () => posted.filter((m) => m.type === 'init'),
    tokens: () => posted.filter((m) => m.type === 'token'),
    refresh: async () => {
      await vi.advanceTimersByTimeAsync(1000)
      await flush()
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('attachBridgeHost', () => {
  it('应答 ready 的 init 与以前同一个格式：旧版页面端照常握手', async () => {
    const h = setup()
    await h.ready()
    expect(h.inits()).toEqual([
      { channel: CHANNEL, type: 'init', nonce: expect.any(String), token: 't1', theme: 'light', plugin: 'foo', base: '/p/foo' },
    ])
  })

  it('同一次加载里重复的 ready 只应答一次，也不再签新令牌', async () => {
    const h = setup()
    h.message({ channel: CHANNEL, type: 'ready' })
    h.message({ channel: CHANNEL, type: 'ready' }) // 取令牌期间又来一次
    await flush()
    await h.ready()
    expect(h.inits()).toHaveLength(1)
    expect(h.getToken).toHaveBeenCalledTimes(1)
  })

  it('页面在 load 之前握手（模块脚本的常见时序）：自己的 load 不打断刷新；跳到下一页照常握手', async () => {
    const h = setup()
    await h.ready()
    h.load() // 它自己的 load
    await h.refresh()
    expect(h.tokens()).toHaveLength(1)

    // 在 iframe 里跳到 /p/foo/ui/detail：新文档同样在自己的 load 之前发 ready
    await h.ready()
    expect(h.inits()).toHaveLength(2)
    h.load()
    await h.refresh()
    expect(h.tokens()).toHaveLength(2)
  })

  it('iframe 换了文档、新文档还没握手：一枚令牌都不推；握手后恢复', async () => {
    const h = setup()
    await h.ready()
    h.load()
    h.load() // 链到了别的页面，它没发 ready
    await h.refresh()
    await h.refresh()
    expect(h.tokens()).toHaveLength(0)

    await h.ready()
    expect(h.inits()).toHaveLength(2)
    await h.refresh()
    expect(h.tokens()).toHaveLength(1)
  })

  it('页面在 load 之后才握手：下一个 load 就是换了文档', async () => {
    const h = setup()
    h.load()
    await h.ready()
    await h.refresh()
    expect(h.tokens()).toHaveLength(1)
    h.load()
    await h.refresh()
    expect(h.tokens()).toHaveLength(1)
  })

  it('取令牌期间 iframe 换了文档：init 不交给接替它的文档', async () => {
    let release: (t: string) => void = () => {}
    const h = setup({ getToken: () => new Promise<string>((r) => (release = r)) })
    h.load()
    await h.ready()
    h.load() // 发 ready 的那个文档已经被换掉
    release('late')
    await flush()
    expect(h.inits()).toHaveLength(0)
  })

  it('取令牌失败不算握手：不推刷新，页面再发 ready 可以重试', async () => {
    let fail = true
    const h = setup({ getToken: async () => (fail ? Promise.reject(new Error('401')) : 'ok') })
    await h.ready()
    await h.refresh()
    expect(h.posted).toHaveLength(0)
    fail = false
    await h.ready()
    expect(h.inits()).toHaveLength(1)
  })

  it('不是 iframe 发来的 ready 不理；destroy 之后不再应答、不再刷新', async () => {
    const h = setup()
    await h.ready({ postMessage() {} })
    expect(h.inits()).toHaveLength(0)

    await h.ready()
    h.host.destroy()
    h.load()
    await h.ready()
    await h.refresh()
    expect(h.inits()).toHaveLength(1)
    expect(h.tokens()).toHaveLength(0)
  })
})
