/**
 * Worker 入口（createRuntime().fetch）的路由与每请求开销：
 *  - /healthz 不带参数时响应一字不变；带 plugins=1 时求值全部插件，有失败回 503（部署流水线据此决定切不切流量）
 *  - 面板静态资源与 404 不建 RequestScope，一次 KV 都不读
 *  - 连续事件只在第一次读 rt:bot / rt:token，之后走 isolate 内缓存
 */
import { definePlugin, extractManifest } from '@qqbot/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetLifecycle } from './lifecycle.js'
import { createRuntime } from './runtime.js'
import { resetSnapshotCache } from './store.js'
import {
  createEnv,
  createExecutionContext,
  createQQFetch,
  groupMessagePayload,
  signedRequest,
  TEST_APPID,
  TEST_SECRET,
} from './testing/mocks.js'

const BASE = 'https://bot.test'

beforeEach(() => {
  resetSnapshotCache()
  resetLifecycle()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

/** 记下每次 KV 读的键 */
function countingEnv(overrides: Parameters<typeof createEnv>[0] = {}) {
  const env = createEnv(overrides)
  const reads: string[] = []
  const raw = env.KV as unknown as { get(key: string, type?: string): Promise<unknown> }
  const get = raw.get.bind(env.KV)
  raw.get = (key, type) => {
    reads.push(key)
    return get(key, type)
  }
  return { env, reads }
}

const good = definePlugin({ name: 'good', version: '1.0.0', commands: { hi: () => '你好' } })
const broken = {
  manifest: { ...extractManifest(good, {}), name: 'broken' },
  load: async () => {
    throw new Error('SyntaxError: Unexpected token')
  },
}

describe('/healthz', () => {
  it('不带参数：响应与以前完全一致，也不求值插件', async () => {
    const runtime = createRuntime({ plugins: [good, broken], projection: 'sha256-x' })
    const res = await runtime.fetch!(new Request(`${BASE}/healthz`), createEnv(), createExecutionContext())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, runtime: expect.any(String), projection: 'sha256-x', plugins: 2 })
  })

  it('plugins=1 且全部加载成功：200，pluginErrors 为空', async () => {
    const runtime = createRuntime({ plugins: [good] })
    const res = await runtime.fetch!(new Request(`${BASE}/healthz?plugins=1`), createEnv(), createExecutionContext())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, runtime: expect.any(String), projection: null, plugins: 1, pluginErrors: [] })
  })

  it('plugins=1 且有插件加载失败：503，ok: false，列出是谁、为什么', async () => {
    const runtime = createRuntime({ plugins: [good, broken] })
    const res = await runtime.fetch!(new Request(`${BASE}/healthz?plugins=1`), createEnv(), createExecutionContext())
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({
      ok: false,
      plugins: 2,
      pluginErrors: [{ name: 'broken', message: 'SyntaxError: Unexpected token' }],
    })
  })
})

describe('路由先判定、后建 scope', () => {
  const ui = { version: 'v1', files: { 'index.html': { body: '<div id=app></div>', type: 'text/html' } } }

  it('面板资源和 404 一次 KV 都不读', async () => {
    const runtime = createRuntime({ plugins: [], ui })
    const { env, reads } = countingEnv()
    expect((await runtime.fetch!(new Request(`${BASE}/`), env, createExecutionContext())).status).toBe(200)
    expect((await runtime.fetch!(new Request(`${BASE}/plugins`), env, createExecutionContext())).status).toBe(200)
    expect((await runtime.fetch!(new Request(`${BASE}/nope.png`), env, createExecutionContext())).status).toBe(404)
    expect((await createRuntime({ plugins: [] }).fetch!(new Request(`${BASE}/`), env, createExecutionContext())).status).toBe(404)
    expect(reads).toEqual([])
  })

  it('优先级不变：根路径带签名头的 POST 仍是回调，admin / 插件路由照常建 scope', async () => {
    const runtime = createRuntime({ plugins: [], ui })
    const { env, reads } = countingEnv()
    const verify = await runtime.fetch!(
      await signedRequest(`${BASE}/`, { op: 13, d: { plain_token: 'abc', event_ts: '1725442341' } }),
      env,
      createExecutionContext(),
    )
    expect(await verify.json()).toMatchObject({ plain_token: 'abc', signature: expect.any(String) })
    expect(reads).toContain('rt:snapshot')

    // 不带签名头的根路径 POST 不是回调，交给面板资源（只认 GET/HEAD）→ 404
    expect((await runtime.fetch!(new Request(`${BASE}/`, { method: 'POST' }), env, createExecutionContext())).status).toBe(404)
    expect((await runtime.fetch!(new Request(`${BASE}/admin/status`), env, createExecutionContext())).status).toBe(401)
    expect((await runtime.fetch!(new Request(`${BASE}/p/none/x`), env, createExecutionContext())).status).toBe(404)
  })
})

describe('每个事件的 KV 读', () => {
  it('面板保存凭证时：连续几个事件 rt:bot、rt:token 都只读一次', async () => {
    const qq = createQQFetch()
    const runtime = createRuntime({ plugins: [good], fetchImpl: qq.fetchImpl })
    const { env, reads } = countingEnv({ BOT_APPID: undefined, BOT_SECRET: undefined })
    env.KV.store.set('rt:bot', JSON.stringify({ appId: TEST_APPID, secret: TEST_SECRET }))

    for (let i = 0; i < 3; i++) {
      const execCtx = createExecutionContext()
      const res = await runtime.fetch!(await signedRequest(`${BASE}/webhook`, groupMessagePayload('/hi')), env, execCtx)
      expect(res.status).toBe(200)
      await execCtx.flush()
    }

    expect(qq.sent).toHaveLength(3)
    expect(reads.filter((k) => k === 'rt:bot')).toHaveLength(1)
    expect(reads.filter((k) => k === 'rt:token')).toHaveLength(1)
  })
})
