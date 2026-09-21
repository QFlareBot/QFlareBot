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

function createFetchMock(manifests: Record<string, unknown>, builds: Array<Record<string, unknown>> = [], atomSha = 'f6a7b8c9d0000000000000000000000000000000') {
  return (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('commits.atom')) {
      const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>tag:github.com,2008:Repository/1/commit/${atomSha}</id></entry></feed>`
      return new Response(xml, { status: 200 })
    }
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
    [{ build_uuid: 'build-9', status: 'stopped', build_outcome: 'success', build_trigger_metadata: { commit_hash: 'c'.repeat(40) } }],
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
    expect(data.previous).toMatchObject({ version: '1.0.0' })
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

describe('构建目标自发现（省略 CF_WORKER_TAG / CF_TRIGGER_UUID）', () => {
  const ok = (result: unknown) => new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 })

  /** 带 discovery 端点的 mock：可数调用次数、可定制 triggers 列表 */
  function discoveryMock(opts: { triggers?: Array<Record<string, unknown>>; scripts?: Array<Record<string, unknown>> } = {}) {
    const calls: string[] = []
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith('/workers/scripts')) return ok(opts.scripts ?? [{ id: 'qqbot', tag: 'tag' }])
      if (url.endsWith('/builds/workers/tag/triggers')) return ok(opts.triggers ?? [{ trigger_uuid: 'trig-1' }])
      if (url.endsWith('/builds/triggers/trig-1/builds') || url.endsWith('/builds/triggers/trig-2/builds')) {
        return ok({ build_uuid: 'build-9' })
      }
      return new Response(`unexpected ${url}`, { status: 500 })
    }) as typeof fetch
    return { fetchImpl, calls }
  }

  function discoverySetup(fetchImpl: typeof fetch, envOverrides: Record<string, unknown> = {}) {
    const runtime = createRuntime({ plugins: [], fetchImpl })
    const env = createEnv({
      DB: createManifestD1(),
      CF_ACCOUNT_ID: 'acc',
      CF_BUILDS_TOKEN: 'tok',
      ...envOverrides,
    })
    const call = (path: string, init: RequestInit = {}) =>
      runtime.fetch!(new Request(`${BASE}${path}`, init), env, createExecutionContext())
    return { call, env }
  }

  it('按 WORKER_NAME 自发现 tag 与 trigger 并缓存 KV，第二次触发不再查询', async () => {
    const { fetchImpl, calls } = discoveryMock()
    const { call, env } = discoverySetup(fetchImpl, { WORKER_NAME: 'qqbot' })

    const first = await call('/admin/builds', { method: 'POST', headers: { authorization: `Bearer ${ADMIN}` } })
    expect(first.status).toBe(200)
    expect(((await first.json()) as { buildUuid: string }).buildUuid).toBe('build-9')
    expect(calls.some((u) => u.endsWith('/workers/scripts'))).toBe(true)
    expect(await env.KV.get('rt:cf_build_targets', 'json')).toEqual({ workerTag: 'tag', triggerUuid: 'trig-1' })

    const scriptsCallsBefore = calls.filter((u) => u.endsWith('/workers/scripts')).length
    const second = await call('/admin/builds', { method: 'POST', headers: { authorization: `Bearer ${ADMIN}` } })
    expect(second.status).toBe(200)
    expect(calls.filter((u) => u.endsWith('/workers/scripts')).length).toBe(scriptsCallsBefore)
  })

  it('仓库未连接（triggers 为空）：返回 502 并提示连接仓库', async () => {
    const { fetchImpl } = discoveryMock({ triggers: [] })
    const { call } = discoverySetup(fetchImpl, { WORKER_NAME: 'qqbot' })
    const res = await call('/admin/builds', { method: 'POST', headers: { authorization: `Bearer ${ADMIN}` } })
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: string }).error).toContain('连接')
  })

  it('WORKER_NAME 对不上脚本名：报错并提示同步 vars', async () => {
    const { fetchImpl } = discoveryMock({ scripts: [{ id: 'other-bot', tag: 'tag2' }] })
    const { call } = discoverySetup(fetchImpl, { WORKER_NAME: 'qqbot' })
    const res = await call('/admin/builds', { method: 'POST', headers: { authorization: `Bearer ${ADMIN}` } })
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: string }).error).toContain('WORKER_NAME')
  })

  it('缓存的 trigger 失效：清缓存重新自发现，重试一次成功', async () => {
    // KV 里预埋一个过期 trigger（模拟重连过仓库），对它的触发一律 400
    let seenStale = false
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/builds/triggers/trig-stale/builds')) {
        seenStale = true
        return new Response(JSON.stringify({ success: false, errors: [{ code: 1, message: 'no such trigger' }], result: null }), { status: 400 })
      }
      if (url.endsWith('/workers/scripts')) return ok([{ id: 'qqbot', tag: 'tag' }])
      if (url.endsWith('/builds/workers/tag/triggers')) return ok([{ trigger_uuid: 'trig-2' }])
      if (url.endsWith('/builds/triggers/trig-2/builds')) return ok({ build_uuid: 'build-10' })
      return new Response(`unexpected ${url}`, { status: 500 })
    }) as typeof fetch
    const { call, env } = discoverySetup(fetchImpl, { WORKER_NAME: 'qqbot' })
    await env.KV.put('rt:cf_build_targets', JSON.stringify({ workerTag: 'tag', triggerUuid: 'trig-stale' }))

    const res = await call('/admin/builds', { method: 'POST', headers: { authorization: `Bearer ${ADMIN}` } })
    expect(res.status).toBe(200)
    expect(seenStale).toBe(true)
    expect(((await res.json()) as { buildUuid: string }).buildUuid).toBe('build-10')
    expect(await env.KV.get('rt:cf_build_targets', 'json')).toEqual({ workerTag: 'tag', triggerUuid: 'trig-2' })
  })

  it('env 显式配置仍优先于自发现', async () => {
    const { fetchImpl, calls } = discoveryMock()
    const { call } = discoverySetup(fetchImpl, { CF_WORKER_TAG: 'tag', CF_TRIGGER_UUID: 'trig-1', WORKER_NAME: 'qqbot' })
    const res = await call('/admin/builds', { method: 'POST', headers: { authorization: `Bearer ${ADMIN}` } })
    expect(res.status).toBe(200)
    expect(calls.some((u) => u.endsWith('/workers/scripts'))).toBe(false)
  })
})

describe('构建状态同步的真实形状', () => {
  it('outcome 映射：success→ok、fail→failed、无 outcome（进行中）→building', async () => {
    const buildsFixture = [
      { build_uuid: 'b-ok', status: 'stopped', build_outcome: 'success', build_trigger_metadata: { commit_hash: 'a'.repeat(40) } },
      { build_uuid: 'b-fail', status: 'stopped', build_outcome: 'fail' },
      { build_uuid: 'b-run', status: 'running' },
    ]
    const fetchImpl = createFetchMock({}, buildsFixture)
    const runtime = createRuntime({ plugins: [], fetchImpl })
    const env = createEnv({
      DB: createManifestD1(),
      CF_ACCOUNT_ID: 'acc',
      CF_BUILDS_TOKEN: 'tok',
      CF_WORKER_TAG: 'tag',
      CF_TRIGGER_UUID: 'trig-1',
    })
    const { insertInstall, listInstalls } = await import('./manifestStore.js')
    const db = env.DB!
    await insertInstall(db, { action: 'build', name: null, source: null, manifestHash: 'h1', status: 'building', buildUuid: 'b-ok' }, Date.now() - 60_000)
    await insertInstall(db, { action: 'build', name: null, source: null, manifestHash: 'h2', status: 'building', buildUuid: 'b-fail' }, Date.now() - 60_000)
    await insertInstall(db, { action: 'build', name: null, source: null, manifestHash: 'h3', status: 'building', buildUuid: 'b-run' }, Date.now() - 60_000)

    const res = await runtime.fetch!(
      new Request(`${BASE}/admin/builds`, { headers: { authorization: `Bearer ${ADMIN}` } }),
      env,
      createExecutionContext(),
    )
    const { builds } = (await res.json()) as { builds: Array<{ status: string; cfStatus: string | null; commitHash: string | null }> }
    void builds
    const rows = await import('./manifestStore.js').then((m) => m.listInstalls(db))
    const map = new Map(rows.map((r) => [r.buildUuid, r]))
    expect(map.get('b-ok')).toMatchObject({ status: 'ok', commitHash: 'a'.repeat(40), cfStatus: 'success' })
    expect(map.get('b-fail')).toMatchObject({ status: 'failed', cfStatus: 'fail' })
    expect(map.get('b-run')).toMatchObject({ status: 'building' })
  })

  it('构建列表中找不到且超过 30 分钟：收敛为失败并提示检查 CF_WORKER_TAG', async () => {
    const fetchImpl = createFetchMock({}, [])
    const runtime = createRuntime({ plugins: [], fetchImpl })
    const env = createEnv({
      DB: createManifestD1(),
      CF_ACCOUNT_ID: 'acc',
      CF_BUILDS_TOKEN: 'tok',
      CF_WORKER_TAG: 'tag',
      CF_TRIGGER_UUID: 'trig-1',
    })
    const { insertInstall } = await import('./manifestStore.js')
    const db = env.DB!
    await insertInstall(db, { action: 'build', name: null, source: null, manifestHash: 'h', status: 'building', buildUuid: 'ghost' }, Date.now() - 31 * 60 * 1000)

    const res = await runtime.fetch!(
      new Request(`${BASE}/admin/builds`, { headers: { authorization: `Bearer ${ADMIN}` } }),
      env,
      createExecutionContext(),
    )
    const { builds } = (await res.json()) as { builds: Array<{ status: string; error: string | null }> }
    expect(builds[0]).toMatchObject({ status: 'failed' })
    expect(builds[0]!.error).toContain('CF_WORKER_TAG')
  })

  it('列表中找不到但未满 30 分钟：保持构建中', async () => {
    const fetchImpl = createFetchMock({}, [])
    const runtime = createRuntime({ plugins: [], fetchImpl })
    const env = createEnv({
      DB: createManifestD1(),
      CF_ACCOUNT_ID: 'acc',
      CF_BUILDS_TOKEN: 'tok',
      CF_WORKER_TAG: 'tag',
      CF_TRIGGER_UUID: 'trig-1',
    })
    const { insertInstall } = await import('./manifestStore.js')
    const db = env.DB!
    await insertInstall(db, { action: 'build', name: null, source: null, manifestHash: 'h', status: 'building', buildUuid: 'ghost' }, Date.now() - 5 * 60 * 1000)

    const res = await runtime.fetch!(
      new Request(`${BASE}/admin/builds`, { headers: { authorization: `Bearer ${ADMIN}` } }),
      env,
      createExecutionContext(),
    )
    const { builds } = (await res.json()) as { builds: Array<{ status: string }> }
    expect(builds[0]).toMatchObject({ status: 'building' })
  })
})

describe('插件检查更新与一键更新', () => {
  const NEW_SHA = 'f6a7b8c9d0000000000000000000000000000000'
  const post = (call: (path: string, init?: RequestInit) => Promise<Response>, path: string, body?: unknown) =>
    call(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })

  function setupWithNewVersion() {
    const fetchImpl = createFetchMock({
      'raw.githubusercontent.com/me/qqbot-plugin-hello/a1b2c3d4e5/manifest.json': declaredManifest(),
      'raw.githubusercontent.com/me/qqbot-plugin-hello/f6a7b8c9d0/manifest.json': declaredManifest({ version: '2.0.0' }),
      [`raw.githubusercontent.com/me/qqbot-plugin-hello/${NEW_SHA}/manifest.json`]: declaredManifest({ version: '2.0.0' }),
    })
    const runtime = createRuntime({ plugins: [], fetchImpl })
    const env = createEnv({
      DB: createManifestD1(),
      CF_ACCOUNT_ID: 'acc',
      CF_BUILDS_TOKEN: 'tok',
      CF_WORKER_TAG: 'tag',
      CF_TRIGGER_UUID: 'trig-1',
    })
    const call = (path: string, init: RequestInit = {}) =>
      runtime.fetch!(new Request(`${BASE}${path}`, init), env, createExecutionContext())
    return { call, env }
  }

  it('check-update：解析 commits.atom，返回上游版本且 upToDate=false', async () => {
    const { call } = setupWithNewVersion()
    await post(call, '/admin/manifest/plugins', { source: 'git:me/qqbot-plugin-hello@a1b2c3d4e5' })

    const res = await post(call, '/admin/manifest/plugins/hello/check-update')
    expect(res.status).toBe(200)
    const data = (await res.json()) as { upToDate: boolean; latestSha: string; latestVersion: string | null; latestSource: string }
    expect(data.upToDate).toBe(false)
    expect(data.latestSha).toBe(NEW_SHA)
    expect(data.latestVersion).toBe('2.0.0')
    expect(data.latestSource).toBe(`git:me/qqbot-plugin-hello@${NEW_SHA}`)
  })

  it('check-update：本地已是最新时 upToDate=true 且不拉清单', async () => {
    const { call } = setupWithNewVersion()
    await post(call, '/admin/manifest/plugins', { source: `git:me/qqbot-plugin-hello@${NEW_SHA}` })
    const res = await post(call, '/admin/manifest/plugins/hello/check-update')
    const data = (await res.json()) as { upToDate: boolean; latestVersion: string | null }
    expect(data.upToDate).toBe(true)
    expect(data.latestVersion).toBeNull()
  })

  it('update：换钉子到最新 commit、写 upgrade 账本并自动触发构建', async () => {
    const { call } = setupWithNewVersion()
    await post(call, '/admin/manifest/plugins', { source: 'git:me/qqbot-plugin-hello@a1b2c3d4e5' })

    const res = await post(call, '/admin/manifest/plugins/hello/update')
    expect(res.status).toBe(200)
    const data = (await res.json()) as {
      previous?: { version: string }
      latestSource: string
      plugin: { version: string }
      build: { buildUuid?: string; error?: string }
    }
    expect(data.previous).toMatchObject({ version: '1.0.0' })
    expect(data.plugin.version).toBe('2.0.0')
    expect(data.build.buildUuid).toBe('build-9')

    // 清单里的源码确实换到了新 commit
    const manifest = await call('/admin/build-manifest', { headers: { authorization: `Bearer ${ADMIN}` } })
    const { plugins } = (await manifest.json()) as { plugins: Array<{ source: string }> }
    expect(plugins[0]!.source).toBe(`git:me/qqbot-plugin-hello@${NEW_SHA}`)
  })

  it('update：已是最新时直接返回，不触发构建', async () => {
    const { call } = setupWithNewVersion()
    await post(call, '/admin/manifest/plugins', { source: `git:me/qqbot-plugin-hello@${NEW_SHA}` })
    const res = await post(call, '/admin/manifest/plugins/hello/update')
    const data = (await res.json()) as { upToDate: boolean; build?: unknown }
    expect(data.upToDate).toBe(true)
    expect(data.build).toBeUndefined()
  })

  it('内置插件返回 404 与专门提示', async () => {
    const { call } = setup({}, [{ name: 'echo', version: '1.0.0' }])
    const res = await post(call, '/admin/manifest/plugins/echo/check-update')
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toContain('内置插件')
  })
})
