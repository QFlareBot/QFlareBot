import { definePlugin } from '@qqbot/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authenticate, issueBridge, issueSession, signToken, verifyToken } from './auth.js'
import { resetEventsSchema } from './events.js'
import { matchPath } from './http.js'
import { resetLifecycle } from './lifecycle.js'
import { resetLogsCache } from './logs.js'
import { createRuntime } from './runtime.js'
import { resetSnapshotCache } from './store.js'
import { dispatchMessage } from './webhook.js'
import { createEnv, createExecutionContext, groupMessagePayload, signedRequest } from './testing/mocks.js'

const BASE = 'https://bot.test'
const SECRET = 'admin-token'

beforeEach(() => {
  resetSnapshotCache()
  resetLifecycle()
  resetEventsSchema()
  resetLogsCache()
})

describe('auth 令牌', () => {
  it('签发/验证/过期/篡改', async () => {
    const t = await signToken({ kind: 'session', exp: Math.floor(Date.now() / 1000) + 60 }, SECRET)
    expect(await verifyToken(t, SECRET)).toMatchObject({ kind: 'session' })
    expect(await verifyToken(t, 'other')).toBeNull()
    expect(await verifyToken(t.slice(0, -2) + 'xx', SECRET)).toBeNull()
    const expired = await signToken({ kind: 'session', exp: Math.floor(Date.now() / 1000) - 60 }, SECRET)
    expect(await verifyToken(expired, SECRET)).toBeNull()
  })

  it('authenticate 区分管理密钥、会话与桥接', async () => {
    const req = (bearer: string) => new Request(BASE, { headers: { authorization: `Bearer ${bearer}` } })
    expect(await authenticate(req(SECRET), SECRET)).toEqual({ admin: true, bridgePlugin: undefined })
    expect(await authenticate(req(await issueSession(SECRET)), SECRET)).toEqual({ admin: true, bridgePlugin: undefined })
    expect(await authenticate(req(await issueBridge(SECRET, 'foo')), SECRET)).toEqual({ admin: false, bridgePlugin: 'foo' })
    expect(await authenticate(req('nope'), SECRET)).toEqual({ admin: false, bridgePlugin: undefined })
    expect(await authenticate(req(SECRET), undefined)).toEqual({ admin: false, bridgePlugin: undefined })
    const viaQuery = new Request(`${BASE}/?token=${await issueBridge(SECRET, 'foo')}`)
    expect((await authenticate(viaQuery, SECRET)).bridgePlugin).toBe('foo')
  })
})

describe('matchPath 通配', () => {
  it('末尾 /* 捕获剩余路径，可为空', () => {
    expect(matchPath('/ui/*', '/ui/')).toEqual({ '*': '' })
    expect(matchPath('/ui/*', '/ui/assets/app.js')).toEqual({ '*': 'assets/app.js' })
    expect(matchPath('/ui/*', '/other')).toBeNull()
    expect(matchPath('/items/:id/*', '/items/7/a/b')).toEqual({ id: '7', '*': 'a/b' })
  })
})

describe('登录与面板资源', () => {
  const ui = {
    version: 'v1',
    index: 'index.html',
    files: {
      'index.html': { body: '<!doctype html><div id=app></div>', type: 'text/html; charset=utf-8' },
      'assets/app-abc12345.js': { body: 'console.log(1)', type: 'text/javascript' },
    },
  }

  it('/admin/login 用管理密钥换会话令牌，令牌可访问其他接口', async () => {
    const runtime = createRuntime({ plugins: [] })
    const env = createEnv()
    const bad = await runtime.fetch!(new Request(`${BASE}/admin/login`, { method: 'POST', body: JSON.stringify({ token: 'x' }) }), env, createExecutionContext())
    expect(bad.status).toBe(401)
    const ok = await runtime.fetch!(new Request(`${BASE}/admin/login`, { method: 'POST', body: JSON.stringify({ token: SECRET }) }), env, createExecutionContext())
    const { session } = (await ok.json()) as { session: string }
    const status = await runtime.fetch!(new Request(`${BASE}/admin/status`, { headers: { authorization: `Bearer ${session}` } }), env, createExecutionContext())
    expect(status.status).toBe(200)
    // 没配构建 token：查不了 Workers Logs，统计为 null
    expect(await status.json()).toMatchObject({ ok: true, webhookPath: '/webhook', stats: null })
  })

  it('传入 ui 时根路径返回 index，带指纹的资源不可变缓存，SPA 回退，保留路径不受影响', async () => {
    const runtime = createRuntime({ plugins: [], ui })
    const env = createEnv()
    const index = await runtime.fetch!(new Request(`${BASE}/`), env, createExecutionContext())
    expect(index.status).toBe(200)
    expect(index.headers.get('content-type')).toContain('text/html')
    expect(index.headers.get('cache-control')).toBe('no-cache')

    const asset = await runtime.fetch!(new Request(`${BASE}/assets/app-abc12345.js`), env, createExecutionContext())
    expect(asset.headers.get('cache-control')).toContain('immutable')
    const etag = asset.headers.get('etag')!
    const cached = await runtime.fetch!(new Request(`${BASE}/assets/app-abc12345.js`, { headers: { 'if-none-match': etag } }), env, createExecutionContext())
    expect(cached.status).toBe(304)

    const fallback = await runtime.fetch!(new Request(`${BASE}/plugins`), env, createExecutionContext())
    expect(await fallback.text()).toContain('id=app')
    const missing = await runtime.fetch!(new Request(`${BASE}/nope.png`), env, createExecutionContext())
    expect(missing.status).toBe(404)
    const health = await runtime.fetch!(new Request(`${BASE}/healthz`), env, createExecutionContext())
    expect(await health.json()).toMatchObject({ ok: true })
  })

  it('不传 ui 时根路径 404', async () => {
    const runtime = createRuntime({ plugins: [] })
    const res = await runtime.fetch!(new Request(`${BASE}/`), createEnv(), createExecutionContext())
    expect(res.status).toBe(404)
  })
})

describe('插件路由鉴权与通配', () => {
  const plugin = definePlugin({
    name: 'panelish',
    version: '1.0.0',
    ui: { path: '/ui/', title: '面板' },
    routes: [
      { method: 'GET', path: '/ui/*', auth: 'admin', handler: async ({ params, authenticated }) => new Response(`ui:${params['*']}:${authenticated}`) },
      { method: 'GET', path: '/public', handler: async ({ authenticated }) => new Response(`public:${authenticated}`) },
    ],
  })

  it('admin 路由拒绝匿名，接受会话与本插件桥接令牌，拒绝他人的桥接令牌', async () => {
    const runtime = createRuntime({ plugins: [plugin] })
    const env = createEnv()
    const get = (path: string, bearer?: string) =>
      runtime.fetch!(new Request(`${BASE}${path}`, bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {}), env, createExecutionContext())

    expect((await get('/p/panelish/ui/')).status).toBe(401)
    expect(await (await get('/p/panelish/ui/a/b.js', await issueSession(SECRET))).text()).toBe('ui:a/b.js:true')
    expect(await (await get('/p/panelish/ui/', await issueBridge(SECRET, 'panelish'))).text()).toBe('ui::true')
    expect((await get('/p/panelish/ui/', await issueBridge(SECRET, 'other'))).status).toBe(401)
    expect(await (await get('/p/panelish/public')).text()).toBe('public:false')
    expect(await (await get('/p/panelish/public', SECRET)).text()).toBe('public:true')
  })

  it('/admin/plugins/:name/bridge 签发限定插件的令牌；status 暴露 ui 声明', async () => {
    const runtime = createRuntime({ plugins: [plugin] })
    const env = createEnv()
    const res = await runtime.fetch!(new Request(`${BASE}/admin/plugins/panelish/bridge`, { method: 'POST', headers: { authorization: `Bearer ${SECRET}` } }), env, createExecutionContext())
    const { token } = (await res.json()) as { token: string }
    expect((await authenticate(new Request(BASE, { headers: { authorization: `Bearer ${token}` } }), SECRET)).bridgePlugin).toBe('panelish')

    const status = await runtime.fetch!(new Request(`${BASE}/admin/status`, { headers: { authorization: `Bearer ${SECRET}` } }), env, createExecutionContext())
    const data = (await status.json()) as { plugins: Array<{ name: string; ui: unknown; routes: unknown[] }> }
    expect(data.plugins[0]).toMatchObject({ name: 'panelish', ui: { path: '/ui/', title: '面板' } })
    expect(data.plugins[0]!.routes).toHaveLength(2)
  })
})

const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
vi.spyOn(console, 'warn').mockImplementation(() => {})
vi.spyOn(console, 'error').mockImplementation(() => {})

describe('事件记录', () => {
  const echo = definePlugin({
    name: 'echo',
    version: '1.0.0',
    commands: { echo: { async handler({ session, argText }) { await session.reply(argText) } } },
    regex: [{ pattern: '^boom$', async handler() { throw new Error('boom') } }],
  })
  const admin = { authorization: `Bearer ${SECRET}` }
  const qqFetch = (async () => new Response(JSON.stringify({ access_token: 't', expires_in: 7200, id: 'm' }), { status: 200 })) as typeof fetch

  async function deliver(runtime: ReturnType<typeof createRuntime>, env: ReturnType<typeof createEnv>, content: string, id: string) {
    const ctx = createExecutionContext()
    await runtime.fetch!(await signedRequest(`${BASE}/webhook`, groupMessagePayload(content, id)), env, ctx)
    await ctx.flush()
  }

  it('每个事件打一行 kind=dispatch 的摘要日志，不带正文；D1 不写', async () => {
    const runtime = createRuntime({ plugins: [echo], fetchImpl: qqFetch })
    const env = createEnv()
    consoleLog.mockClear()
    await deliver(runtime, env, '/echo hi', 'e1')
    await deliver(runtime, env, 'boom', 'e2')
    expect(env.DB.rows).toHaveLength(0)

    const lines = consoleLog.mock.calls.map(([line]) => JSON.parse(String(line))).filter((l) => l.data?.kind === 'dispatch')
    expect(lines.map((l) => l.data)).toEqual([
      {
        kind: 'dispatch',
        id: 'GROUP_AT_MESSAGE_CREATE:e1',
        event: 'qq.group.at_message',
        scene: 'group',
        userId: 'U1',
        targetId: 'G1',
        matched: [{ plugin: 'echo', kind: 'command', name: 'echo' }],
        outbox: 1,
        failed: 0,
        ok: true,
      },
      expect.objectContaining({ id: 'GROUP_AT_MESSAGE_CREATE:e2', ok: false, errors: [expect.objectContaining({ plugin: 'echo', message: 'boom' })] }),
    ])
    expect(JSON.stringify(lines)).not.toContain('/echo hi')
    // Cloudflare 后台日志列表的 Message 列显示的就是这行
    expect(lines[0].message).toBe('group.at_message · 群 G1 · 用户 U1 → echo/echo · 回复 1 条')
    expect(lines[1].message).toMatch(/^group\.at_message · 群 G1 · 用户 U1 → echo\/.+ · 1 个错误：echo boom$/)
  })

  it('摘要里的长 openid 只留开头，没命中、发送失败都写清楚', () => {
    const report = { matched: [], errors: [] }
    expect(dispatchMessage('qq.c2c.message', 'c2c', 'ABCDEF0123456789', 'ABCDEF0123456789', report, 0, 0)).toBe(
      'c2c.message · 单聊 ABCDEF01… · 用户 ABCDEF01… → 无插件命中 · 无回复',
    )
    expect(dispatchMessage('qq.group.member_added', 'group', 'G1', '', { matched: [{ plugin: 'hi', kind: 'event', name: 'qq.group.member_added' }], errors: [] }, 1, 1)).toBe(
      'group.member_added · 群 G1 → hi/qq.group.member_added · 发送失败 1 条',
    )
  })

  it('开了实时调试才写进 D1，/admin/events 可查正文', async () => {
    const runtime = createRuntime({ plugins: [echo], fetchImpl: qqFetch })
    const env = createEnv()
    await deliver(runtime, env, '/echo before', 'e0')

    const on = await runtime.fetch!(new Request(`${BASE}/admin/live`, { method: 'POST', headers: admin, body: JSON.stringify({ on: true }) }), env, createExecutionContext())
    expect((await on.json()) as { until: number }).toMatchObject({ ok: true, until: expect.any(Number) })
    await deliver(runtime, env, '/echo hi', 'e1')
    await deliver(runtime, env, 'boom', 'e2')

    const res = await runtime.fetch!(new Request(`${BASE}/admin/events?limit=10`, { headers: admin }), env, createExecutionContext())
    const { events } = (await res.json()) as { events: Array<{ id: string; content: string; matched: string; errors: string; outbox: number }> }
    expect(events.map((e) => e.id)).toEqual(['GROUP_AT_MESSAGE_CREATE:e2', 'GROUP_AT_MESSAGE_CREATE:e1'])
    expect(events[1]).toMatchObject({ content: '/echo hi', outbox: 1 })
    expect(JSON.parse(events[1]!.matched)).toEqual([{ plugin: 'echo', kind: 'command', name: 'echo' }])
    expect(JSON.parse(events[0]!.errors)[0]).toMatchObject({ plugin: 'echo', message: 'boom' })

    await runtime.fetch!(new Request(`${BASE}/admin/live`, { method: 'POST', headers: admin, body: JSON.stringify({ on: false }) }), env, createExecutionContext())
    await deliver(runtime, env, '/echo after', 'e3')
    expect(env.DB.rows).toHaveLength(2)

    const bad = await runtime.fetch!(new Request(`${BASE}/admin/live`, { method: 'POST', headers: admin, body: '{}' }), env, createExecutionContext())
    expect(bad.status).toBe(400)
  })

  it('/admin/logs 与统计走 Workers Logs；没权限时如实说明', async () => {
    let allowed = true
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes('/workers/observability/telemetry/query')) return qqFetch(input, init)
      if (!allowed) return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }), { status: 403 })
      const body = JSON.parse(String(init?.body)) as { view: string }
      const result =
        body.view === 'calculations'
          ? { calculations: [{ aggregates: [{ groups: [{ value: 'true' }], count: 5 }, { groups: [{ value: 'false' }], count: 1 }] }] }
          : { events: { events: [{ timestamp: 1, source: { data: { kind: 'dispatch', id: 'e1', event: 'qq.group.message' } } }] } }
      return new Response(JSON.stringify({ success: true, result }), { status: 200 })
    }) as typeof fetch
    const runtime = createRuntime({ plugins: [], fetchImpl })
    const env = createEnv({ CF_ACCOUNT_ID: 'acc', CF_BUILDS_TOKEN: 'tok' })

    const logs = await runtime.fetch!(new Request(`${BASE}/admin/logs?limit=1`, { headers: admin }), env, createExecutionContext())
    expect(await logs.json()).toMatchObject({ ok: true, available: true, sampled: false, events: [{ id: 'e1', content: '' }] })
    // status 不等日志查询：第一次先给 null，后台查回来后下一次就有了
    const first = createExecutionContext()
    const pending = await runtime.fetch!(new Request(`${BASE}/admin/status`, { headers: admin }), env, first)
    expect((await pending.json()).stats).toBeNull()
    await first.flush()
    const status = await runtime.fetch!(new Request(`${BASE}/admin/status`, { headers: admin }), env, createExecutionContext())
    expect((await status.json()).stats).toEqual({ total: 6, last24h: 6, errors24h: 1 })

    allowed = false
    const denied = await runtime.fetch!(new Request(`${BASE}/admin/logs`, { headers: admin }), env, createExecutionContext())
    expect(await denied.json()).toMatchObject({ ok: true, available: false, reason: 'no-permission', events: [] })
    const noToken = await runtime.fetch!(new Request(`${BASE}/admin/logs`, { headers: admin }), createEnv(), createExecutionContext())
    expect(await noToken.json()).toMatchObject({ available: false, reason: 'no-token' })
  })
})

describe('未绑定 D1', () => {
  it('事件不记录、status.bindings.d1=false、events 返回空、插件 ctx.db 报可读错误', async () => {
    const plugin = definePlugin({
      name: 'dbuser',
      version: '1.0.0',
      commands: { q: { async handler({ ctx, session }) { try { await ctx.db.all('select 1') } catch (e) { await session.reply((e as Error).message) } } } },
    })
    const runtime = createRuntime({ plugins: [plugin] })
    const env = createEnv({ DB: undefined })
    const admin = { authorization: `Bearer ${SECRET}` }
    const status = await runtime.fetch!(new Request(`${BASE}/admin/status`, { headers: admin }), env, createExecutionContext())
    // 这条只关心 D1 缺失；R2 由 createEnv 默认提供
    expect((await status.json()).bindings).toEqual({ kv: true, d1: false, r2: true })
    const events = await runtime.fetch!(new Request(`${BASE}/admin/events`, { headers: admin }), env, createExecutionContext())
    expect((await events.json()).events).toEqual([])
    const dry = await runtime.fetch!(new Request(`${BASE}/admin/test-event`, { method: 'POST', headers: admin, body: JSON.stringify({ content: '/q' }) }), env, createExecutionContext())
    expect((await dry.json()).outbox[0].message).toContain('未绑定 D1')
  })
})

describe('回调地址填成根路径', () => {
  it('带签名头的 POST / 按 webhook 处理，GET / 仍是面板', async () => {
    const runtime = createRuntime({ plugins: [], ui: { version: 'v', files: { 'index.html': { body: '<div id=app>', type: 'text/html' } } } })
    const env = createEnv()
    const body = { op: 13, d: { plain_token: 'abc', event_ts: '1725442341' } }
    const res = await runtime.fetch!(await signedRequest(`${BASE}/`, body), env, createExecutionContext())
    expect(res.status).toBe(200)
    expect(((await res.json()) as { plain_token: string }).plain_token).toBe('abc')
    const page = await runtime.fetch!(new Request(`${BASE}/`), env, createExecutionContext())
    expect(await page.text()).toContain('id=app')
  })
})
