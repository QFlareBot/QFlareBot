import { beforeEach, describe, expect, it } from 'vitest'
import { createRuntime } from './runtime.js'
import { resetManifestSchema } from './manifestStore.js'
import { resetSnapshotCache } from './store.js'
import { resetLifecycle } from './lifecycle.js'
import { resetEventsSchema } from './events.js'
import { createEnv, createExecutionContext, createManifestD1 } from './testing/mocks.js'

const BASE = 'https://bot.test'
const ADMIN = 'admin-token'
const BUILD_TOKEN = 'build-token'

function declaredManifest(overrides: Record<string, unknown> = {}) {
  return {
    name: 'hello',
    version: '1.0.0',
    apiVersion: 1,
    permissions: [],
    depends: {},
    conflicts: [],
    commands: [],
    regex: [],
    events: [],
    buttons: [],
    cron: [],
    routes: [],
    hasMiddleware: false,
    services: [],
    durableObjects: [],
    ...overrides,
  }
}

function createFetchMock(manifests: Record<string, unknown>, builds: Array<Record<string, unknown>> = []) {
  return (async (input: string | URL | Request) => {
    const url = String(input)
    for (const [fragment, manifest] of Object.entries(manifests)) {
      if (url.includes(fragment)) return new Response(JSON.stringify(manifest), { status: 200 })
    }
    if (url.includes('/builds/triggers/trig-1/builds')) {
      return new Response(JSON.stringify({ success: true, result: { build_uuid: 'build-9' } }), { status: 200 })
    }
    if (url.includes('/builds/workers/tag/builds')) {
      return new Response(JSON.stringify({ success: true, result: { items: builds } }), { status: 200 })
    }
    return new Response(`unexpected ${url}`, { status: 500 })
  }) as typeof fetch
}

function setup(overrides: Record<string, unknown> = {}, plugins: Parameters<typeof createRuntime>[0]['plugins'] = []) {
  const fetchImpl = createFetchMock(
    {
      'raw.githubusercontent.com/me/qqbot-plugin-hello/a1b2c3d4e5/manifest.json': declaredManifest(),
      'raw.githubusercontent.com/me/qqbot-plugin-clash/b2c3d4e5f6/manifest.json': declaredManifest({ name: 'clash', conflicts: ['echo'] }),
      'raw.githubusercontent.com/me/qqbot-plugin-needy/c3d4e5f6a7/manifest.json': declaredManifest({ name: 'needy', depends: { greet: '*' } }),
      'raw.githubusercontent.com/me/qqbot-plugin-hello/f6a7b8c9d0/manifest.json': declaredManifest({ version: '2.0.0' }),
    },
    [{ build_uuid: 'build-9', status: 'success', build_trigger_metadata: { commit_hash: 'c'.repeat(40) } }],
  )
  const runtime = createRuntime({ plugins, fetchImpl })
  const env = createEnv({
    DB: createManifestD1(),
    BUILD_TOKEN,
    CF_ACCOUNT_ID: 'acc',
    CF_BUILDS_TOKEN: 'tok',
    CF_WORKER_TAG: 'tag',
    CF_TRIGGER_UUID: 'trig-1',
    ...overrides,
  })
  const call = (path: string, init: RequestInit = {}) =>
    runtime.fetch!(new Request(`${BASE}${path}`, init), env, createExecutionContext())
  const admin = { authorization: `Bearer ${ADMIN}` }
  return { call, env, admin }
}

beforeEach(() => {
  resetSnapshotCache()
  resetLifecycle()
  resetEventsSchema()
  resetManifestSchema()
})

describe('GET /admin/build-manifest', () => {
  it('匿名拒绝；BUILD_TOKEN 与管理密钥都能访问；返回清单与哈希', async () => {
    const { call } = setup()
    expect((await call('/admin/build-manifest')).status).toBe(401)

    const viaBuild = await call('/admin/build-manifest', { headers: { authorization: `Bearer ${BUILD_TOKEN}` } })
    expect(viaBuild.status).toBe(200)
    const data = (await viaBuild.json()) as { ok: boolean; hash: string; plugins: unknown[] }
    expect(data).toMatchObject({ ok: true, plugins: [] })
    expect(data.hash).toMatch(/^[0-9a-f]{64}$/)

    const viaAdmin = await call('/admin/build-manifest', { headers: { authorization: `Bearer ${ADMIN}` } })
    expect(viaAdmin.status).toBe(200)
  })

  it('未绑定 D1 返回 503，构建机据此回退内置清单', async () => {
    const { call } = setup({ DB: undefined })
    const res = await call('/admin/build-manifest', { headers: { authorization: `Bearer ${ADMIN}` } })
    expect(res.status).toBe(503)
  })
})

describe('POST /admin/manifest/plugins', () => {
  it('安装：拉声明清单校验后写入 D1，账本 pending', async () => {
    const { call } = setup()
    const res = await call('/admin/manifest/plugins', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'git:me/qqbot-plugin-hello@a1b2c3d4e5' }),
    })
    expect(res.status).toBe(200)
    const data = (await res.json()) as { plugin: { name: string; source: string }; install: { status: string } }
    expect(data.plugin).toEqual({ name: 'hello', version: '1.0.0', source: 'git:me/qqbot-plugin-hello@a1b2c3d4e5' })
    expect(data.install.status).toBe('pending')

    const manifest = await call('/admin/build-manifest', { headers: { authorization: `Bearer ${BUILD_TOKEN}` } })
    const { plugins } = (await manifest.json()) as { plugins: Array<{ name: string }> }
    expect(plugins.map((p) => p.name)).toEqual(['hello'])
  })

  it('升级：同名插件再次安装记为 upgrade', async () => {
    const { call } = setup()
    const post = (sha: string) =>
      call('/admin/manifest/plugins', {
        method: 'POST',
        headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ source: `git:me/qqbot-plugin-hello@${sha}` }),
      })
    await post('a1b2c3d4e5')
    const res = await post('f6a7b8c9d0')
    const data = (await res.json()) as { install: { action: string }; previous?: { version: string } }
    expect(data.install.action).toBe('upgrade')
    expect(data.previous).toEqual({ version: '1.0.0' })
  })

  it('非法 source 与缺声明清单返回 400', async () => {
    const { call } = setup()
    const bad = await call('/admin/manifest/plugins', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'npm:qqbot-plugin-hello' }),
    })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: string }).error).toContain('git:')

    const missing = await call('/admin/manifest/plugins', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'git:me/unknown@d4e5f6a7b8' }),
    })
    expect(missing.status).toBe(400)
    expect(((await missing.json()) as { error: string }).error).toContain('声明清单')
  })

  it('conflicts 撞已装插件 409，依赖缺失 400', async () => {
    const { call } = setup({}, [{ name: 'echo', version: '1.0.0' }])
    const clash = await call('/admin/manifest/plugins', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'git:me/qqbot-plugin-clash@b2c3d4e5f6' }),
    })
    expect(clash.status).toBe(409)
    expect(((await clash.json()) as { error: string }).error).toContain('conflicts echo')

    const needy = await call('/admin/manifest/plugins', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'git:me/qqbot-plugin-needy@c3d4e5f6a7' }),
    })
    expect(needy.status).toBe(400)
    expect(((await needy.json()) as { error: string }).error).toContain('依赖未满足：greet')
  })
})

describe('DELETE /admin/manifest/plugins/:name', () => {
  it('卸载后从清单移除；内置插件给出专门提示', async () => {
    const { call } = setup({}, [{ name: 'echo', version: '1.0.0' }])
    const install = await call('/admin/manifest/plugins', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'git:me/qqbot-plugin-hello@a1b2c3d4e5' }),
    })
    expect(install.status).toBe(200)

    const remove = await call('/admin/manifest/plugins/hello', { method: 'DELETE', headers: { authorization: `Bearer ${ADMIN}` } })
    expect(remove.status).toBe(200)
    const manifest = await call('/admin/build-manifest', { headers: { authorization: `Bearer ${BUILD_TOKEN}` } })
    expect(((await manifest.json()) as { plugins: unknown[] }).plugins).toEqual([])

    const again = await call('/admin/manifest/plugins/echo', { method: 'DELETE', headers: { authorization: `Bearer ${ADMIN}` } })
    expect(again.status).toBe(404)
    expect(((await again.json()) as { error: string }).error).toContain('仓库清单内置')
  })
})

describe('自部署触发与状态同步', () => {
  it('未配置 CF_* 返回 503 并列出缺失变量', async () => {
    const { call } = setup({ CF_ACCOUNT_ID: undefined, CF_BUILDS_TOKEN: undefined, CF_WORKER_TAG: undefined, CF_TRIGGER_UUID: undefined })
    const res = await call('/admin/builds', { method: 'POST', headers: { authorization: `Bearer ${ADMIN}` } })
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toContain('CF_ACCOUNT_ID')
  })

  it('触发构建：pending 记录并入构建，账本同步 success 与 commit', async () => {
    const { call } = setup()
    await call('/admin/manifest/plugins', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'git:me/qqbot-plugin-hello@a1b2c3d4e5' }),
    })
    const trigger = await call('/admin/builds', { method: 'POST', headers: { authorization: `Bearer ${ADMIN}` } })
    expect(trigger.status).toBe(200)
    const { buildUuid, hash } = (await trigger.json()) as { buildUuid: string; hash: string }
    expect(buildUuid).toBe('build-9')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)

    const list = await call('/admin/builds', { headers: { authorization: `Bearer ${ADMIN}` } })
    const { builds } = (await list.json()) as { builds: Array<{ status: string; commitHash: string | null; action: string }> }
    expect(builds.length).toBe(2)
    expect(builds.every((b) => b.status === 'ok' && b.commitHash === 'c'.repeat(40))).toBe(true)
    expect(builds.map((b) => b.action).sort()).toEqual(['build', 'install'])
  })

  it('触发失败记入账本并返回 502', async () => {
    const failing = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/builds/triggers/trig-1/builds')) {
        return new Response(JSON.stringify({ success: false, errors: [{ code: 1, message: 'Invalid token' }], result: null }), { status: 400 })
      }
      return new Response('unexpected', { status: 500 })
    }) as typeof fetch
    const runtime = createRuntime({ plugins: [], fetchImpl: failing })
    const env = createEnv({ DB: createManifestD1(), CF_ACCOUNT_ID: 'acc', CF_BUILDS_TOKEN: 'tok', CF_WORKER_TAG: 'tag', CF_TRIGGER_UUID: 'trig-1' })
    const res = await runtime.fetch!(new Request(`${BASE}/admin/builds`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}` } }), env, createExecutionContext())
    expect(res.status).toBe(502)
    const data = (await res.json()) as { error: string }
    expect(data.error).toContain('Invalid token')
  })
})
