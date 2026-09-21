import { createMockContext } from '@qqbot/sdk/testing'
import type { PluginContext } from '@qqbot/sdk'
import { describe, expect, it, vi } from 'vitest'
import plugin, { type PluginConfig } from './index.js'
import { T2I } from './t2i.js'

const CONFIG = plugin.defaultConfig! as PluginConfig

describe('T2I Class', () => {
  const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])

  function mockFetchOnce(): ReturnType<typeof vi.fn> {
    return vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => JPEG_BYTES.buffer,
    })
  }

  it('endpoint 由配置的 URL 拼接并去掉尾部斜杠', () => {
    expect(new T2I({ url: 'https://t2i.example.com/' }).endpoint).toBe('https://t2i.example.com/text2img/generate')
    expect(new T2I({ url: '' }).endpoint).toContain('clown145-astrbot-t2i-service.hf.space')
  })

  it('renderBase64 返回可直接回复的 base64', async () => {
    const fetchMock = mockFetchOnce()
    vi.stubGlobal('fetch', fetchMock)

    const t2i = new T2I({ url: 'https://t2i.example.com', timeoutMs: 5000 })
    const { base64, byteSize } = await t2i.renderBase64('<p>hi</p>', { width: 100, height: 100 })

    expect(byteSize).toBe(JPEG_BYTES.byteLength)
    expect(base64).toBe(btoa(String.fromCharCode(...JPEG_BYTES)))
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.options.viewport).toEqual({ width: 100, height: 100 })
    vi.unstubAllGlobals()
  })

  it('ping 成功返回耗时，失败返回错误信息', async () => {
    vi.stubGlobal('fetch', mockFetchOnce())
    const ok = await new T2I({ url: 'https://t2i.example.com' }).ping()
    expect(ok.ok).toBe(true)
    expect(ok.latencyMs).toBeGreaterThanOrEqual(0)
    vi.unstubAllGlobals()

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')))
    const bad = await new T2I({ url: 'https://t2i.example.com' }).ping()
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain('boom')
    vi.unstubAllGlobals()
  })
})

describe('t2i Service', () => {
  it('向其他插件导出 t2i 服务，实例绑定面板配置', () => {
    expect(Object.keys(plugin.services ?? {})).toContain('t2i')
    const ctx = createMockContext(plugin, {
      config: { ...CONFIG, t2i_url: 'https://my-t2i.example.com' },
    })
    const svc = plugin.services!.t2i!(ctx)
    expect(svc).toBeInstanceOf(T2I)
    expect((svc as T2I).endpoint).toBe('https://my-t2i.example.com/text2img/generate')
  })
})

describe('Plugin Page API', () => {
  function callRoute(path: string, method = 'GET', init?: RequestInit) {
    const route = plugin.routes!.find((r) => r.path === path && r.method === method)!
    return (ctx: PluginContext<PluginConfig>) =>
      route.handler({
        ctx,
        request: new Request(`https://bot.test${path}`, { method, ...init }),
        params: {},
        authenticated: true,
      })
  }

  it('/api/config 返回端点与超时', async () => {
    const res = (await callRoute('/api/config')(createMockContext(plugin))) as Response
    const body = (await res.json()) as Record<string, unknown>
    expect(body.endpoint).toBe('https://clown145-astrbot-t2i-service.hf.space/text2img/generate')
    expect(body.timeoutMs).toBe(25000)
  })

  it('/api/render 成功返回 base64 与耗时', async () => {
    const JPEG_BYTES = new Uint8Array([0x01, 0x02, 0x03])
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'image/jpeg' },
        arrayBuffer: async () => JPEG_BYTES.buffer,
      }),
    )

    const res = (await callRoute('/api/render', 'POST', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ html: '<p>hi</p>' }),
    })(createMockContext(plugin))) as Response

    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; base64: string; byteSize: number; latencyMs: number }
    expect(body.ok).toBe(true)
    expect(body.byteSize).toBe(3)
    expect(typeof body.latencyMs).toBe('number')
    vi.unstubAllGlobals()
  })

  it('/api/render 空 html 返回 400，渲染失败返回 502', async () => {
    const empty = (await callRoute('/api/render', 'POST', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ html: '  ' }),
    })(createMockContext(plugin))) as Response
    expect(empty.status).toBe(400)

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('node down')))
    const failed = (await callRoute('/api/render', 'POST', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ html: '<p>hi</p>' }),
    })(createMockContext(plugin))) as Response
    expect(failed.status).toBe(502)
    expect(((await failed.json()) as { error: string }).error).toContain('node down')
    vi.unstubAllGlobals()
  })
})
