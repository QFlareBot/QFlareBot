/**
 * 插件 HTTP 路由（/p/<插件>/…）的三条约束：
 *  - 和事件分发一样先跑生命周期钩子：新装插件第一次被访问的可能是页面，onInstall 没跑过表就不存在
 *  - 安全模式下一律 503
 *  - admin 路由返回的 HTML 带 CSP sandbox：面板「新窗口打开」时插件页与面板同源，不能让它读到会话令牌
 */
import { definePlugin } from '@qqbot/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { issueSession } from './auth.js'
import { resetLifecycle } from './lifecycle.js'
import { createRuntime } from './runtime.js'
import { resetSnapshotCache } from './store.js'
import { createEnv, createExecutionContext } from './testing/mocks.js'

const BASE = 'https://bot.test'
const SECRET = 'admin-token'
const SANDBOX = 'sandbox allow-scripts allow-forms allow-popups allow-downloads'

beforeEach(() => {
  resetSnapshotCache()
  resetLifecycle()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const html = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', ...headers } })

describe('插件路由', () => {
  it('第一次访问就先跑 onInstall，处理器看得到它建的东西', async () => {
    const calls: string[] = []
    const plugin = definePlugin({
      name: 'fresh',
      version: '1.0.0',
      hooks: {
        onInstall: async () => void calls.push('install'),
        onBoot: async () => void calls.push('boot'),
      },
      routes: [
        {
          method: 'GET',
          path: '/stats',
          handler: async () => {
            calls.push('handler')
            return Response.json({ ok: true })
          },
        },
      ],
    })
    const runtime = createRuntime({ plugins: [plugin] })
    const env = createEnv()

    const res = await runtime.fetch!(new Request(`${BASE}/p/fresh/stats`), env, createExecutionContext())
    expect(res.status).toBe(200)
    await runtime.fetch!(new Request(`${BASE}/p/fresh/stats`), env, createExecutionContext())
    expect(calls).toEqual(['install', 'boot', 'handler', 'handler'])
    expect(env.KV.store.get('rt:installed:fresh')).toBe('1.0.0')
  })

  it('admin 路由鉴权不过时不跑钩子', async () => {
    const calls: string[] = []
    const plugin = definePlugin({
      name: 'guarded',
      version: '1.0.0',
      hooks: { onInstall: async () => void calls.push('install') },
      routes: [{ method: 'GET', path: '/ui/*', auth: 'admin', handler: async () => html('<p>hi</p>') }],
    })
    const runtime = createRuntime({ plugins: [plugin] })
    const res = await runtime.fetch!(new Request(`${BASE}/p/guarded/ui/`), createEnv(), createExecutionContext())
    expect(res.status).toBe(401)
    expect(calls).toEqual([])
  })

  it('安全模式下返回 503（带 CORS），插件代码一行不跑', async () => {
    const calls: string[] = []
    const plugin = definePlugin({
      name: 'paused',
      version: '1.0.0',
      routes: [
        {
          method: 'GET',
          path: '/public',
          handler: async () => {
            calls.push('handler')
            return new Response('hi')
          },
        },
      ],
    })
    const runtime = createRuntime({ plugins: [plugin] })
    const env = createEnv()
    env.KV.store.set('rt:snapshot', JSON.stringify({ revision: 1, plugins: {}, safeMode: true }))

    const res = await runtime.fetch!(new Request(`${BASE}/p/paused/public`), env, createExecutionContext())
    expect(res.status).toBe(503)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(calls).toEqual([])
  })

  describe('admin 路由的 HTML 带 CSP sandbox', () => {
    const plugin = definePlugin({
      name: 'paged',
      version: '1.0.0',
      routes: [
        { method: 'GET', path: '/ui/*', auth: 'admin', handler: async () => html('<p>page</p>') },
        { method: 'GET', path: '/own-csp', auth: 'admin', handler: async () => html('<p>own</p>', { 'content-security-policy': "img-src 'self'" }) },
        { method: 'GET', path: '/api/data', auth: 'admin', handler: async () => Response.json({ ok: true }) },
        { method: 'GET', path: '/public', handler: async () => html('<p>public</p>') },
      ],
    })

    async function get(path: string) {
      const runtime = createRuntime({ plugins: [plugin] })
      return runtime.fetch!(
        new Request(`${BASE}/p/paged${path}`, { headers: { authorization: `Bearer ${await issueSession(SECRET)}` } }),
        createEnv(),
        createExecutionContext(),
      )
    }

    it('与面板 iframe 的 sandbox 属性一致，正文不变', async () => {
      const res = await get('/ui/')
      expect(res.headers.get('content-security-policy')).toBe(SANDBOX)
      expect(res.headers.get('access-control-allow-origin')).toBe('*')
      expect(await res.text()).toBe('<p>page</p>')
    })

    it('插件自己带的 CSP 保留，两条同时生效', async () => {
      const res = await get('/own-csp')
      expect(res.headers.get('content-security-policy')).toBe(`img-src 'self', ${SANDBOX}`)
    })

    it('非 HTML 的 admin 路由、公开路由不加', async () => {
      expect((await get('/api/data')).headers.get('content-security-policy')).toBeNull()
      expect((await get('/public')).headers.get('content-security-policy')).toBeNull()
    })
  })
})
