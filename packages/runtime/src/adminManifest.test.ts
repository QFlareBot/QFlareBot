import { beforeEach, describe, expect, it } from 'vitest'
import { definePlugin, type Manifest } from '@qqbot/sdk'
import { BUILD_COMMAND, BUILD_PATH_EXCLUDES, DEPLOY_COMMAND } from '@qqbot/projector'
import { createRuntime } from './runtime.js'
import { resetManifestSchema } from './manifestStore.js'
import { resetSnapshotCache } from './store.js'
import { resetLifecycle } from './lifecycle.js'
import { resetEventsSchema } from './events.js'
import { createEnv, createExecutionContext, createManifestD1 } from './testing/mocks.js'
import type { ScheduledController } from '@cloudflare/workers-types'

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

/** 本次 fetch mock 记录到的 trigger 配置写入（构建命令 / 构建环境变量） */
interface TriggerWrite {
  url: string
  body: unknown
}

function createFetchMock(
  manifests: Record<string, unknown>,
  builds: Array<Record<string, unknown>> = [],
  atomSha = 'f6a7b8c9d0000000000000000000000000000000',
  triggerWrites: TriggerWrite[] = [],
) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
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
    if (url.endsWith('/builds/workers/tag/triggers')) {
      // notes/* 是「用户自己在后台加的排除路径」：补写排除路径时不能把它弄丢
      const trigger = { trigger_uuid: 'trig-1', branch_includes: ['main'], path_excludes: ['notes/*'] }
      return new Response(JSON.stringify({ success: true, result: [trigger] }), { status: 200 })
    }
    // trigger 配置写入（PATCH）：记下来供断言，注意别和上面的 /builds 触发端点混淆
    if (/\/builds\/triggers\/[^/]+(\/environment_variables)?$/.test(url)) {
      triggerWrites.push({ url, body: JSON.parse(String(init?.body ?? '{}')) })
      return new Response(JSON.stringify({ success: true, result: {} }), { status: 200 })
    }
    return new Response(`unexpected ${url}`, { status: 500 })
  }) as typeof fetch
}

function setup(overrides: Record<string, unknown> = {}, plugins: Parameters<typeof createRuntime>[0]['plugins'] = []) {
  const triggerWrites: TriggerWrite[] = []
  const fetchImpl = createFetchMock(
    {
      'raw.githubusercontent.com/me/qqbot-plugin-hello/a1b2c3d4e5/manifest.json': declaredManifest(),
      'raw.githubusercontent.com/me/qqbot-plugin-clash/b2c3d4e5f6/manifest.json': declaredManifest({ name: 'clash', conflicts: ['echo'] }),
      'raw.githubusercontent.com/me/qqbot-plugin-needy/c3d4e5f6a7/manifest.json': declaredManifest({ name: 'needy', depends: { greet: '*' } }),
      'raw.githubusercontent.com/me/qqbot-plugin-hello/f6a7b8c9d0/manifest.json': declaredManifest({ version: '2.0.0' }),
      'raw.githubusercontent.com/me/qqbot-plugin-game/e5f6a7b8c9/manifest.json': declaredManifest({ name: 'game', durableObjects: ['Room', 'Lobby'] }),
      // 一对表前缀相同的插件名：- 与 _ 都会被 tablePrefix 归一成 _（见 sqlScope.ts）
      'raw.githubusercontent.com/me/qqbot-plugin-dashed/d1e2f3a4b5/manifest.json': declaredManifest({ name: 'my-plugin' }),
      'raw.githubusercontent.com/me/qqbot-plugin-scored/d1e2f3a4b6/manifest.json': declaredManifest({ name: 'my_plugin' }),
      // 提供 greet 服务：needy 依赖它
      'raw.githubusercontent.com/me/qqbot-plugin-greeter/a0b1c2d3e4/manifest.json': declaredManifest({ name: 'greeter', services: ['greet'] }),
      // 同名、别家仓库
      'raw.githubusercontent.com/other/qqbot-plugin-hello/a1b2c3d4e5/manifest.json': declaredManifest(),
      'raw.githubusercontent.com/me/qqbot-plugin-chatty/c0d1e2f3a4/manifest.json': declaredManifest({
        name: 'chatty',
        commands: [{ name: 'ping', aliases: ['p'] }],
        permissions: ['kv'],
      }),
      // game 的两个新版本：DO 类不变 / 新增了一个
      'raw.githubusercontent.com/me/qqbot-plugin-game/e5f6a7b8d0/manifest.json': declaredManifest({
        name: 'game',
        version: '1.1.0',
        durableObjects: ['Room', 'Lobby'],
      }),
      'raw.githubusercontent.com/me/qqbot-plugin-game/e5f6a7b8d1/manifest.json': declaredManifest({
        name: 'game',
        version: '1.2.0',
        durableObjects: ['Room', 'Lobby', 'Arena'],
      }),
    },
    [{ build_uuid: 'build-9', status: 'stopped', build_outcome: 'success', build_trigger_metadata: { commit_hash: 'c'.repeat(40) } }],
    undefined,
    triggerWrites,
  )
  const runtime = createRuntime({ plugins, fetchImpl })
  const db = createManifestD1()
  const env = createEnv({
    DB: db,
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
  return { call, env, admin, triggerWrites, runtime, db }
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

  it('带上 pendingBuild，构建机据此对照「触发时」与「实际构建」的清单哈希', async () => {
    const { call } = setup()
    const jsonHeaders = { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }
    const manifest = async () =>
      (await (await call('/admin/build-manifest', { headers: { authorization: `Bearer ${ADMIN}` } })).json()) as {
        hash: string
        pendingBuild: { buildUuid: string | null; hash: string } | null
      }

    expect((await manifest()).pendingBuild).toBeNull()

    await call('/admin/manifest/plugins', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ source: 'git:me/qqbot-plugin-hello@a1b2c3d4e5' }),
    })
    // 安装就地触发了构建，所以这条记录当场就带上 buildUuid，哈希与当前清单一致
    const installed = await manifest()
    expect(installed.pendingBuild).toMatchObject({ buildUuid: 'build-9', hash: installed.hash })
  })
})

describe('GET /admin/build-config', () => {
  it('匿名拒绝；BUILD_TOKEN 与管理密钥都能访问；返回 Worker 绑定的资源配置', async () => {
    const { call } = setup({
      CF_KV_ID: 'kv-12345',
      CF_D1_ID: 'd1-67890',
      CF_R2_NAME: 'r2-bucket',
    })
    expect((await call('/admin/build-config')).status).toBe(401)

    const viaBuild = await call('/admin/build-config', { headers: { authorization: `Bearer ${BUILD_TOKEN}` } })
    expect(viaBuild.status).toBe(200)
    const data = (await viaBuild.json()) as {
      ok: boolean
      bindings: {
        workerName: string | null
        kvId: string | null
        d1Id: string | null
        r2Name: string | null
        defaultDomain: string | null
        hasD1: boolean
        hasR2: boolean
      }
    }
    expect(data.ok).toBe(true)
    expect(data.bindings).toEqual({
      workerName: null,
      kvId: 'kv-12345',
      d1Id: 'd1-67890',
      r2Name: 'r2-bucket',
      defaultDomain: null,
      hasD1: true,
      hasR2: true,
    })

    const viaAdmin = await call('/admin/build-config', { headers: { authorization: `Bearer ${ADMIN}` } })
    expect(viaAdmin.status).toBe(200)
  })

  it('CF_* 未配置时 id 字段为 null，但 hasD1/hasR2 如实反映绑定', async () => {
    // 这正是最危险的那种形态：secret 一个没写，资源却实实在在绑着。
    // 构建机拿 d1Id === null 当「这次部署没有 D1」会误判，于是清单拉不到时静默放行，
    // D1 里装的插件全部从 Worker 上消失——hasD1 存在就是为了不让它猜。
    const { call } = setup()
    const res = await call('/admin/build-config', { headers: { authorization: `Bearer ${ADMIN}` } })
    expect(res.status).toBe(200)
    const data = (await res.json()) as {
      ok: boolean
      bindings: {
        workerName: string | null
        kvId: string | null
        d1Id: string | null
        r2Name: string | null
        defaultDomain: string | null
        hasD1: boolean
        hasR2: boolean
      }
    }
    expect(data.bindings).toEqual({
      workerName: null,
      kvId: null,
      d1Id: null,
      r2Name: null,
      defaultDomain: null,
      hasD1: true,
      hasR2: true,
    })
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

  it('拒绝与已装插件 D1 表前缀相同的插件（my-plugin 与 my_plugin 同前缀，卸载会误删邻居）', async () => {
    const { call } = setup()
    const install = (repo: string, sha: string) =>
      call('/admin/manifest/plugins', {
        method: 'POST',
        headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ source: `git:me/${repo}@${sha}` }),
      })

    expect((await install('qqbot-plugin-dashed', 'd1e2f3a4b5')).status).toBe(200)
    const clash = await install('qqbot-plugin-scored', 'd1e2f3a4b6')
    expect(clash.status).toBe(409)
    expect(((await clash.json()) as { error: string }).error).toContain('表前缀相同')
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

  it('status 里标记哪些插件来自 D1 清单（面板据此决定是否显示卸载入口）', async () => {
    // 同一个名字：先以「仓库内置」出现在注册表里，再往 D1 里装一份同名的
    const { call } = setup({}, [definePlugin({ name: 'hello' })])
    const statusOf = async () => {
      const res = await call('/admin/status', { headers: { authorization: `Bearer ${ADMIN}` } })
      return ((await res.json()) as { plugins: Array<{ name: string; installed: boolean }> }).plugins
    }

    expect(await statusOf()).toEqual([expect.objectContaining({ name: 'hello', installed: false })])

    await call('/admin/manifest/plugins', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'git:me/qqbot-plugin-hello@a1b2c3d4e5' }),
    })
    expect(await statusOf()).toEqual([expect.objectContaining({ name: 'hello', installed: true })])
  })

  it('卸载后就地触发重建并把 buildUuid 回给面板——只改 D1 清单的话插件还在跑', async () => {
    const { call } = setup()
    await call('/admin/manifest/plugins', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'git:me/qqbot-plugin-hello@a1b2c3d4e5' }),
    })

    const remove = await call('/admin/manifest/plugins/hello', { method: 'DELETE', headers: { authorization: `Bearer ${ADMIN}` } })
    expect(remove.status).toBe(200)
    const body = (await remove.json()) as { build: { buildUuid?: string; error?: string } }
    expect(body.build).toEqual({ buildUuid: 'build-9' })
  })

  it('触发构建失败不回滚卸载：清单已改，如实报错让用户手动重试', async () => {
    // 入口里没有出处信息的老部署：判断不了「清单是否已与线上一致」，照旧每次都触发构建
    const { call } = setup({ CF_ACCOUNT_ID: undefined, CF_BUILDS_TOKEN: undefined }, [{ name: 'echo', version: '1.0.0' }])
    await call('/admin/manifest/plugins', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'git:me/qqbot-plugin-hello@a1b2c3d4e5' }),
    })

    const remove = await call('/admin/manifest/plugins/hello', { method: 'DELETE', headers: { authorization: `Bearer ${ADMIN}` } })
    expect(remove.status).toBe(200)
    const body = (await remove.json()) as { build: { buildUuid?: string; error?: string } }
    expect(body.build.error).toContain('CF_ACCOUNT_ID')

    // 卸载本身仍然生效
    const manifest = await call('/admin/build-manifest', { headers: { authorization: `Bearer ${BUILD_TOKEN}` } })
    expect(((await manifest.json()) as { plugins: unknown[] }).plugins).toEqual([])
  })
})

describe('自部署触发与状态同步', () => {
  it('未配置 CF_* 返回 503 并列出缺失变量', async () => {
    const { call } = setup({ CF_ACCOUNT_ID: undefined, CF_BUILDS_TOKEN: undefined, CF_WORKER_TAG: undefined, CF_TRIGGER_UUID: undefined })
    const res = await call('/admin/builds', { method: 'POST', headers: { authorization: `Bearer ${ADMIN}` } })
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toContain('CF_ACCOUNT_ID')
  })

  it('Cron 自动收敛账本——不再只在有人打开面板时才同步', async () => {
    const { call, env, runtime } = setup()
    // 装一个插件：账本里留下 install + build 两条 building 记录
    await call('/admin/manifest/plugins', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'git:me/qqbot-plugin-hello@a1b2c3d4e5' }),
    })

    await runtime.scheduled!(
      { scheduledTime: Date.now(), cron: '* * * * *', noRetry() {} } as ScheduledController,
      env,
      createExecutionContext(),
    )

    // 没有打开过面板，状态也该回填好了
    const { builds } = (await (await call('/admin/builds', { headers: { authorization: `Bearer ${ADMIN}` } })).json()) as {
      builds: Array<{ status: string; cfStatus: string | null }>
    }
    expect(builds.every((b) => b.status === 'ok' && b.cfStatus === 'success')).toBe(true)
  })

  it('账本里没有进行中的记录时，Cron 不发任何请求', async () => {
    const { env, runtime, triggerWrites } = setup({ CF_DEFAULT_DOMAIN: 'qqbot.workers.dev' })
    await runtime.scheduled!(
      { scheduledTime: Date.now(), cron: '* * * * *', noRetry() {} } as ScheduledController,
      env,
      createExecutionContext(),
    )
    // 连 trigger 自配置都不该被触发：整条路径在 listInstalls 判空时就返回了
    expect(triggerWrites).toEqual([])
  })

  it('声明了 Durable Object 的插件先拦下来，给出要往 wrangler.jsonc 补的 migrations', async () => {
    const { call, triggerWrites } = setup()
    const res = await call('/admin/manifest/plugins', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'git:me/qqbot-plugin-game@e5f6a7b8c9' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string; code: string }
    expect(body.code).toBe('durable_objects_migration_required')
    // 报的必须是投影后的导出名——用户照着抄进 wrangler.jsonc，构建期的 checkDoMigrations 才认
    expect(body.error).toContain('"new_sqlite_classes": ["P_game_Room", "P_game_Lobby"]')

    // 拦下来就不该留任何痕迹：没写 D1、没记账本、更没触发构建
    const manifest = await (await call('/admin/build-manifest', { headers: { authorization: `Bearer ${ADMIN}` } })).json()
    expect((manifest as { plugins: unknown[] }).plugins).toEqual([])
    expect(triggerWrites).toEqual([])
  })

  it('确认已补 migrations 后放行', async () => {
    const { call } = setup()
    const res = await call('/admin/manifest/plugins', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'git:me/qqbot-plugin-game@e5f6a7b8c9', acknowledgeDurableObjects: true }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()) as { plugin: { name: string } }).toMatchObject({ plugin: { name: 'game' } })
  })

  it('安装就地触发构建——不依赖面板前端补发，curl 装也一样生效', async () => {
    const { call } = setup()
    const res = await call('/admin/manifest/plugins', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'git:me/qqbot-plugin-hello@a1b2c3d4e5' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()) as { build: unknown }).toMatchObject({ build: { buildUuid: 'build-9' } })

    const { builds } = (await (await call('/admin/builds', { headers: { authorization: `Bearer ${ADMIN}` } })).json()) as {
      builds: Array<{ action: string; buildUuid: string | null }>
    }
    // 安装那条被 markPendingBuilding 并进了这次构建，不会留一条永远 pending 的孤儿
    expect(builds.map((b) => b.action).sort()).toEqual(['build', 'install'])
    expect(builds.every((b) => b.buildUuid === 'build-9')).toBe(true)
  })

  it('触发构建时顺手把构建命令、清单环境变量与排除路径写进 trigger，且只写一次', async () => {
    const { call, triggerWrites } = setup({ CF_DEFAULT_DOMAIN: 'qqbot.workers.dev' })
    await call('/admin/builds', { method: 'POST', headers: { authorization: `Bearer ${ADMIN}` } })

    const commands = triggerWrites.find((w) => w.url.endsWith('/builds/triggers/trig-1'))
    expect(commands?.body).toEqual({
      build_command: BUILD_COMMAND,
      deploy_command: DEPLOY_COMMAND,
      path_excludes: ['notes/*', ...BUILD_PATH_EXCLUDES],
    })
    const envVars = triggerWrites.find((w) => w.url.endsWith('/environment_variables'))
    expect(envVars?.body).toEqual({
      MANIFEST_URL: { value: 'https://qqbot.workers.dev/admin/build-manifest', is_secret: false },
      MANIFEST_TOKEN: { value: BUILD_TOKEN, is_secret: true },
    })

    // 第二次不再写：用户后来在后台的手动调整不该被覆盖回去
    const before = triggerWrites.length
    await call('/admin/builds', { method: 'POST', headers: { authorization: `Bearer ${ADMIN}` } })
    expect(triggerWrites.length).toBe(before)
  })

  it('老版本写过配置的（标记是时间字符串）：只补一次排除路径，构建命令与环境变量不再动', async () => {
    const { call, env, triggerWrites } = setup({ CF_DEFAULT_DOMAIN: 'qqbot.workers.dev' })
    await env.KV.put('rt:cf_trigger_configured', '2026-09-20T08:00:00.000Z')
    await call('/admin/builds', { method: 'POST', headers: { authorization: `Bearer ${ADMIN}` } })

    expect(triggerWrites).toEqual([{ url: expect.stringMatching(/\/builds\/triggers\/trig-1$/), body: { path_excludes: ['notes/*', ...BUILD_PATH_EXCLUDES] } }])
    expect(JSON.parse((await env.KV.get('rt:cf_trigger_configured'))!)).toMatchObject({ version: 2 })

    await call('/admin/builds', { method: 'POST', headers: { authorization: `Bearer ${ADMIN}` } })
    expect(triggerWrites).toHaveLength(1)
  })

  it('拿不到自己的对外地址时不写 trigger——写错的 MANIFEST_URL 比不写更难查', async () => {
    const { call, triggerWrites } = setup()
    await call('/admin/builds', { method: 'POST', headers: { authorization: `Bearer ${ADMIN}` } })
    expect(triggerWrites).toEqual([])
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
    // install + 它就地触发的 build + 上面这次手动 build
    expect(builds.length).toBe(3)
    expect(builds.every((b) => b.status === 'ok' && b.commitHash === 'c'.repeat(40))).toBe(true)
    expect(builds.map((b) => b.action).sort()).toEqual(['build', 'build', 'install'])
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

describe('触发构建的分支', () => {
  const ok = (result: unknown) => new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 })

  /** triggers 可在两次触发之间改（模拟在 Cloudflare 后台改生产分支）；记下每次触发带的分支 */
  function branchMock(initial: Array<Record<string, unknown>> | null) {
    const state = { triggers: initial, branches: [] as string[] }
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/workers/scripts')) return ok([{ id: 'qqbot', tag: 'tag' }])
      if (url.endsWith('/builds/workers/tag/triggers')) {
        return state.triggers ? ok(state.triggers) : new Response(JSON.stringify({ success: false, errors: [{ code: 1, message: 'boom' }] }), { status: 500 })
      }
      if (/\/builds\/triggers\/[^/]+\/builds$/.test(url)) {
        state.branches.push(JSON.parse(String(init?.body)).branch)
        return ok({ build_uuid: `build-${state.branches.length}` })
      }
      return new Response(`unexpected ${url}`, { status: 500 })
    }) as typeof fetch
    return { fetchImpl, state }
  }

  function branchSetup(fetchImpl: typeof fetch, envOverrides: Record<string, unknown> = {}) {
    const runtime = createRuntime({ plugins: [], fetchImpl })
    const env = createEnv({ DB: createManifestD1(), CF_ACCOUNT_ID: 'acc', CF_BUILDS_TOKEN: 'tok', WORKER_NAME: 'qqbot', ...envOverrides })
    const build = async (body?: unknown) => {
      const res = await runtime.fetch!(
        new Request(`${BASE}/admin/builds`, {
          method: 'POST',
          headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }),
        env,
        createExecutionContext(),
      )
      return { status: res.status, body: (await res.json()) as { branch?: string; error?: string } }
    }
    return { build, env }
  }

  it('没配 CF_BUILD_BRANCH：用连接仓库时选的生产分支，不再写死 main', async () => {
    const { fetchImpl, state } = branchMock([{ trigger_uuid: 'trig-1', branch_includes: ['master'] }])
    const { build } = branchSetup(fetchImpl)
    expect((await build()).body.branch).toBe('master')
    expect(state.branches).toEqual(['master'])
  })

  it('生产分支现查不缓存：后台改了分支，下一次触发就跟着变（trigger_uuid 不变）', async () => {
    const { fetchImpl, state } = branchMock([{ trigger_uuid: 'trig-1', branch_includes: ['master'] }])
    const { build } = branchSetup(fetchImpl)
    await build()
    state.triggers = [{ trigger_uuid: 'trig-1', branch_includes: ['release'] }]
    await build()
    expect(state.branches).toEqual(['master', 'release'])
  })

  it('env 写死 trigger 时按这个 trigger 找分支，不被排在前面的预览 trigger 带偏', async () => {
    const { fetchImpl, state } = branchMock([
      { trigger_uuid: 'preview', branch_includes: ['*'] },
      { trigger_uuid: 'trig-1', branch_includes: ['dev'] },
    ])
    const { build } = branchSetup(fetchImpl, { CF_WORKER_TAG: 'tag', CF_TRIGGER_UUID: 'trig-1' })
    await build()
    expect(state.branches).toEqual(['dev'])
  })

  it('优先级：请求里指定的 > CF_BUILD_BRANCH > 生产分支', async () => {
    const { fetchImpl, state } = branchMock([{ trigger_uuid: 'trig-1', branch_includes: ['master'] }])
    const { build } = branchSetup(fetchImpl, { CF_BUILD_BRANCH: 'pinned' })
    await build()
    await build({ branch: 'hotfix' })
    expect(state.branches).toEqual(['pinned', 'hotfix'])
  })

  it('查不到分支（接口失败 / 没有具体分支名）：回退 main，构建照常触发', async () => {
    const failing = branchMock(null)
    const { build: buildFailing } = branchSetup(failing.fetchImpl, { CF_WORKER_TAG: 'tag', CF_TRIGGER_UUID: 'trig-1' })
    expect((await buildFailing()).status).toBe(200)
    expect(failing.state.branches).toEqual(['main'])

    const bare = branchMock([{ trigger_uuid: 'trig-1' }])
    const { build: buildBare } = branchSetup(bare.fetchImpl)
    await buildBare()
    expect(bare.state.branches).toEqual(['main'])
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

// ---------- 以下覆盖「批量更新 / 未上线插件可卸载 / 构建回报」这一轮改动 ----------

/** 投影出来的懒加载条目：带出处，像构建机产出的入口那样 */
function deployed(
  name: string,
  opts: { version?: string; source?: string; from?: 'd1' | 'repo'; manifest?: Record<string, unknown> } = {},
) {
  const version = opts.version ?? '1.0.0'
  const manifest = declaredManifest({ name, version, ...opts.manifest }) as unknown as Manifest
  return {
    manifest,
    origin: { from: opts.from ?? 'd1', source: opts.source ?? `git:me/qqbot-plugin-${name}@a1b2c3d4e5` },
    load: async () => ({ default: definePlugin({ name, version }) }),
  }
}

const jsonHeaders = { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }

async function install(call: ReturnType<typeof setup>['call'], body: Record<string, unknown>) {
  const res = await call('/admin/manifest/plugins', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) })
  return { res, data: (await res.json()) as Record<string, any> }
}

async function managed(call: ReturnType<typeof setup>['call']) {
  const res = await call('/admin/manifest/plugins', { headers: { authorization: `Bearer ${ADMIN}` } })
  expect(res.status).toBe(200)
  return (await res.json()) as {
    hash: string
    liveHash: string | null
    inSync: boolean | null
    building: boolean
    plugins: Array<{ name: string; state: string; live: { version: string; source: string | null } | null; buildError: string | null; lastRecord: { action: string; status: string } | null; manifest: { services: string[] } | null }>
    removing: Array<{ name: string; source: string }>
  }
}

async function ledger(call: ReturnType<typeof setup>['call']) {
  const res = await call('/admin/builds', { headers: { authorization: `Bearer ${ADMIN}` } })
  return ((await res.json()) as { builds: Array<{ action: string; name: string | null; status: string; buildUuid: string | null; error: string | null }> }).builds
}

describe('GET /admin/manifest/plugins：D1 清单与线上的对照', () => {
  it('没上线的插件列出来、能卸载；清单回到与线上一致时不白跑构建', async () => {
    // 线上只有一个仓库内置插件（带出处 = 新构建机产出的入口）
    const { call, env } = setup({}, [deployed('echo', { from: 'repo', source: 'file:../../plugins/echo/dist/plugin.js' })])
    await install(call, { source: 'git:me/qqbot-plugin-hello@a1b2c3d4e5' })

    let list = await managed(call)
    expect(list.plugins).toEqual([expect.objectContaining({ name: 'hello', state: 'not_deployed', live: null })])
    expect(list.inSync).toBe(false)

    // 构建失败：线上保持原样，hello 还在 D1 里
    await env.DB!.prepare("UPDATE rt_installs SET status = ?, cf_status = ?, commit_hash = ?, error = COALESCE(error, ?) WHERE build_uuid = ?")
      .bind('failed', 'fail', null, '构建未成功：fail', 'build-9')
      .run()

    const remove = await call('/admin/manifest/plugins/hello', { method: 'DELETE', headers: { authorization: `Bearer ${ADMIN}` } })
    expect(remove.status).toBe(200)
    const body = (await remove.json()) as { build: Record<string, unknown>; data: { hook: string } }
    // 从没上线过：没有 onUninstall 可跑，删掉之后清单与线上一致，不必触发构建
    expect(body.data.hook).toBe('none')
    expect(body.build).toMatchObject({ skipped: true })

    list = await managed(call)
    expect(list.plugins).toEqual([])
    expect(list.inSync).toBe(true)
    const rows = await ledger(call)
    expect(rows.find((r) => r.action === 'uninstall')).toMatchObject({ name: 'hello', status: 'ok' })
  })

  it('已上线 / 线上是另一份 / 卸载还没生效，三种状态分得清', async () => {
    const { call } = setup({}, [deployed('hello'), deployed('gone', { source: 'git:me/qqbot-plugin-gone@b2c3d4e5f6' })])
    await install(call, { source: 'git:me/qqbot-plugin-hello@a1b2c3d4e5', build: false })

    let list = await managed(call)
    expect(list.plugins).toEqual([expect.objectContaining({ name: 'hello', state: 'deployed' })])
    // gone 线上还在、D1 里没有：卸载还没生效
    expect(list.removing).toEqual([expect.objectContaining({ name: 'gone', source: 'git:me/qqbot-plugin-gone@b2c3d4e5f6' })])

    await install(call, { source: 'git:me/qqbot-plugin-hello@f6a7b8c9d0', build: false })
    list = await managed(call)
    expect(list.plugins).toEqual([
      expect.objectContaining({ name: 'hello', state: 'differs', live: { version: '1.0.0', source: 'git:me/qqbot-plugin-hello@a1b2c3d4e5', from: 'd1' } }),
    ])
  })

  it('老部署没有出处信息：inSync 为 null，状态按版本号判断', async () => {
    const { call } = setup({}, [definePlugin({ name: 'hello', version: '1.0.0' })])
    await install(call, { source: 'git:me/qqbot-plugin-hello@a1b2c3d4e5', build: false })
    const list = await managed(call)
    expect(list.inSync).toBeNull()
    expect(list.liveHash).toBeNull()
    expect(list.plugins[0]).toMatchObject({ state: 'deployed', live: { version: '1.0.0', source: null } })
  })
})

describe('批量写入：build: false 只写清单，最后只构建一次', () => {
  it('两个插件逐个写入不触发构建，一次 POST /admin/builds 把两条都并进去', async () => {
    const { call } = setup()
    const a = await install(call, { source: 'git:me/qqbot-plugin-greeter@a0b1c2d3e4', build: false })
    // needy 依赖 greet：提供者 greeter 还没构建上线，只在 D1 里——以前会被误拒
    const b = await install(call, { source: 'git:me/qqbot-plugin-needy@c3d4e5f6a7', build: false })
    expect(a.res.status).toBe(200)
    expect(b.res.status).toBe(200)
    expect(a.data.build).toMatchObject({ skipped: true })
    expect((await ledger(call)).filter((r) => r.action === 'build')).toEqual([])

    const trigger = await call('/admin/builds', { method: 'POST', headers: { authorization: `Bearer ${ADMIN}` } })
    expect(trigger.status).toBe(200)
    const rows = await ledger(call)
    // 两条安装记录存的哈希各不相同，都得并进这次构建，不能留一条永远 pending
    expect(rows.map((r) => [r.action, r.name, r.buildUuid])).toEqual(
      expect.arrayContaining([
        ['install', 'greeter', 'build-9'],
        ['install', 'needy', 'build-9'],
        ['build', null, 'build-9'],
      ]),
    )
  })

  it('不传 build 时行为不变：安装就地触发构建', async () => {
    const { call } = setup()
    const { data } = await install(call, { source: 'git:me/qqbot-plugin-hello@a1b2c3d4e5' })
    expect(data.build).toEqual({ buildUuid: 'build-9' })
  })
})

describe('dryRun 预检', () => {
  it('只校验不写：不进 D1、不记账本、不构建', async () => {
    const { call, triggerWrites } = setup()
    const { res, data } = await install(call, { source: 'git:me/qqbot-plugin-chatty@c0d1e2f3a4', dryRun: true })
    expect(res.status).toBe(200)
    expect(data).toMatchObject({
      dryRun: true,
      plugin: { name: 'chatty', version: '1.0.0' },
      manifest: { permissions: ['kv'], commands: ['ping'] },
      warnings: [],
      durableObjects: null,
    })
    expect((await managed(call)).plugins).toEqual([])
    expect(await ledger(call)).toEqual([])
    expect(triggerWrites).toEqual([])
  })

  it('声明了 DO：预检不 409，把要补的 migrations 摆出来', async () => {
    const { call } = setup()
    const { res, data } = await install(call, { source: 'git:me/qqbot-plugin-game@e5f6a7b8c9', dryRun: true })
    expect(res.status).toBe(200)
    expect(data.durableObjects).toMatchObject({ required: true })
    expect(data.durableObjects.message).toContain('"new_sqlite_classes": ["P_game_Room", "P_game_Lobby"]')
  })

  it('硬规则照旧拒绝：依赖缺失，带上 code 供面板批量安装识别', async () => {
    const { call } = setup()
    const { res, data } = await install(call, { source: 'git:me/qqbot-plugin-needy@c3d4e5f6a7', dryRun: true })
    expect(res.status).toBe(400)
    expect(data.error).toContain('依赖未满足：greet')
    expect(data.code).toBe('dependencies_missing')
  })
})

describe('只提醒、不拦的情况（以前能装的现在照样能装）', () => {
  it('同名但换了仓库：照装，给出警告', async () => {
    const { call } = setup()
    await install(call, { source: 'git:me/qqbot-plugin-hello@a1b2c3d4e5' })
    const { res, data } = await install(call, { source: 'git:other/qqbot-plugin-hello@a1b2c3d4e5' })
    expect(res.status).toBe(200)
    expect(data.install.action).toBe('upgrade')
    expect(data.warnings).toEqual([expect.stringContaining('这次会换成 other/qqbot-plugin-hello 的代码')])
  })

  it('命令重名、已装插件声明与它冲突、覆盖同名内置插件：都只是警告', async () => {
    const { call } = setup({}, [
      definePlugin({ name: 'pinger', commands: { ping: () => 'pong' } }),
      definePlugin({ name: 'hater', conflicts: ['chatty'] }),
      definePlugin({ name: 'chatty' }),
    ])
    const { res, data } = await install(call, { source: 'git:me/qqbot-plugin-chatty@c0d1e2f3a4' })
    expect(res.status).toBe(200)
    expect(data.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('与仓库内置插件 chatty 同名'),
        expect.stringContaining('与 pinger 的命令重名：/ping'),
        expect.stringContaining('已装的 hater 声明与 chatty 冲突'),
      ]),
    )
  })

  it('升级新增的权限列进警告', async () => {
    const { call } = setup({}, [deployed('chatty', { source: 'git:me/qqbot-plugin-chatty@c0d1e2f3a3' })])
    const { data } = await install(call, { source: 'git:me/qqbot-plugin-chatty@c0d1e2f3a4' })
    expect(data.warnings).toEqual([expect.stringContaining('新版本新增权限：kv')])
  })
})

describe('Durable Object：只拦新增的类', () => {
  it('确认过 migrations 的插件，升级时 DO 类没变就直接放行；新增了类才要再确认', async () => {
    const { call } = setup()
    expect((await install(call, { source: 'git:me/qqbot-plugin-game@e5f6a7b8c9', acknowledgeDurableObjects: true })).res.status).toBe(200)

    // 类不变：以前每次升级都 409，声明了 DO 的插件永远没法一键更新
    const same = await install(call, { source: 'git:me/qqbot-plugin-game@e5f6a7b8d0' })
    expect(same.res.status).toBe(200)

    const added = await install(call, { source: 'git:me/qqbot-plugin-game@e5f6a7b8d1' })
    expect(added.res.status).toBe(409)
    expect(added.data.code).toBe('durable_objects_migration_required')
    expect(added.data.error).toContain('新增了 Durable Object 类（Arena）')
    expect(added.data.error).toContain('"new_sqlite_classes": ["P_game_Arena"]')
  })

  it('线上部署里已有的类同样算数', async () => {
    const { call } = setup({}, [deployed('game', { manifest: { durableObjects: ['Room', 'Lobby'] } })])
    expect((await install(call, { source: 'git:me/qqbot-plugin-game@e5f6a7b8d0' })).res.status).toBe(200)
  })

  it('check-update 报出新版本新增的权限与 DO 类', async () => {
    const LATEST = 'f6a7b8c9d0000000000000000000000000000000'
    const fetchImpl = createFetchMock({
      'raw.githubusercontent.com/me/qqbot-plugin-game/e5f6a7b8c9/manifest.json': declaredManifest({ name: 'game', durableObjects: ['Room'] }),
      [`raw.githubusercontent.com/me/qqbot-plugin-game/${LATEST}/manifest.json`]: declaredManifest({
        name: 'game',
        version: '2.0.0',
        permissions: ['r2'],
        durableObjects: ['Room', 'Arena'],
      }),
    })
    const runtime = createRuntime({ plugins: [], fetchImpl })
    const env = createEnv({ DB: createManifestD1(), CF_ACCOUNT_ID: 'acc', CF_BUILDS_TOKEN: 'tok', CF_WORKER_TAG: 'tag', CF_TRIGGER_UUID: 'trig-1' })
    const call = (path: string, init: RequestInit = {}) => runtime.fetch!(new Request(`${BASE}${path}`, init), env, createExecutionContext())
    await call('/admin/manifest/plugins', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ source: 'git:me/qqbot-plugin-game@e5f6a7b8c9', acknowledgeDurableObjects: true }) })

    const res = await call('/admin/manifest/plugins/game/check-update', { method: 'POST', headers: jsonHeaders })
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      upToDate: false,
      currentVersion: '1.0.0',
      latestVersion: '2.0.0',
      newPermissions: ['r2'],
      newDurableObjects: ['Arena'],
    })
  })
})

describe('卸载的后半段：等插件真的不在部署里了再收尾', () => {
  /** 跑一次 Cron，并等 waitUntil 里的后台任务（账本同步、卸载收尾）跑完 */
  async function tick(runtime: ReturnType<typeof createRuntime>, env: ReturnType<typeof setup>['env']) {
    const ctx = createExecutionContext()
    await runtime.scheduled!({ scheduledTime: Date.now(), cron: '* * * * *', noRetry() {} } as ScheduledController, env, ctx)
    await ctx.flush()
  }
  /** 新部署：入口里已经没有被卸载的插件；任何网络请求都算意外 */
  const nextDeployment = () =>
    createRuntime({ plugins: [], fetchImpl: (async () => new Response('unexpected', { status: 500 })) as typeof fetch })

  it('旧部署还在时不动；新部署里没它了才删标记、清数据、清快照配置', async () => {
    const { call, env, runtime, db } = setup({}, [deployed('hello')])
    await install(call, { source: 'git:me/qqbot-plugin-hello@a1b2c3d4e5', build: false })
    await env.KV.put('rt:snapshot', JSON.stringify({ revision: 1, plugins: { hello: { enabled: true, config: { a: 1 } } } }))
    resetSnapshotCache()

    const remove = await call('/admin/manifest/plugins/hello?purge=true&build=false', { method: 'DELETE', headers: { authorization: `Bearer ${ADMIN}` } })
    expect(remove.status).toBe(200)
    expect(((await remove.json()) as { build: Record<string, unknown> }).build).toMatchObject({ skipped: true })

    // 重建完成前旧代码还在跑：冷启动的 isolate 重跑 onInstall，把表建回来、把标记写回去
    await env.KV.put('rt:installed:hello', '1.0.0')
    await env.KV.put('p:hello:note', 'x')

    await tick(runtime, env)
    expect(env.KV.store.has('rt:installed:hello')).toBe(true)
    expect(db.cleanups.has('hello')).toBe(true)

    resetSnapshotCache()
    await tick(nextDeployment(), env)
    expect(env.KV.store.has('rt:installed:hello')).toBe(false)
    expect(env.KV.store.has('p:hello:note')).toBe(false)
    expect(JSON.parse(env.KV.store.get('rt:snapshot')!).plugins).toEqual({})
    expect(db.cleanups.size).toBe(0)
  })

  it('不清数据的卸载只删标记，数据与配置都留着', async () => {
    const { call, env } = setup({}, [deployed('hello')])
    await install(call, { source: 'git:me/qqbot-plugin-hello@a1b2c3d4e5', build: false })
    await call('/admin/manifest/plugins/hello?build=false', { method: 'DELETE', headers: { authorization: `Bearer ${ADMIN}` } })
    await env.KV.put('rt:installed:hello', '1.0.0')
    await env.KV.put('p:hello:note', 'x')

    await tick(nextDeployment(), env)
    expect(env.KV.store.has('rt:installed:hello')).toBe(false)
    expect(env.KV.store.get('p:hello:note')).toBe('x')
  })

  it('收尾之前又装回来：取消待清理，别把新装的数据清掉', async () => {
    const { call, db } = setup({}, [deployed('hello')])
    await install(call, { source: 'git:me/qqbot-plugin-hello@a1b2c3d4e5', build: false })
    await call('/admin/manifest/plugins/hello?purge=true&build=false', { method: 'DELETE', headers: { authorization: `Bearer ${ADMIN}` } })
    expect(db.cleanups.has('hello')).toBe(true)
    await install(call, { source: 'git:me/qqbot-plugin-hello@a1b2c3d4e5', build: false })
    expect(db.cleanups.has('hello')).toBe(false)
  })

  it('卸载服务提供者时提醒谁会断掉', async () => {
    const { call } = setup()
    await install(call, { source: 'git:me/qqbot-plugin-greeter@a0b1c2d3e4', build: false })
    await install(call, { source: 'git:me/qqbot-plugin-needy@c3d4e5f6a7', build: false })
    const res = await call('/admin/manifest/plugins/greeter?build=false', { method: 'DELETE', headers: { authorization: `Bearer ${ADMIN}` } })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { warnings?: string[] }).warnings).toEqual([expect.stringContaining('needy')])
  })
})

describe('POST /admin/build-report：构建机回报失败原因', () => {
  const report = (call: ReturnType<typeof setup>['call'], body: unknown, token = BUILD_TOKEN) =>
    call('/admin/build-report', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('匿名拒绝；错误记到 D1 条目与这次构建的账本上，之后同步成失败也不被冲掉', async () => {
    const { call } = setup()
    await install(call, { source: 'git:me/qqbot-plugin-hello@a1b2c3d4e5' })
    expect((await call('/admin/build-report', { method: 'POST', body: '{}' })).status).toBe(401)

    const res = await report(call, {
      buildUuid: 'build-9',
      phase: 'prepare',
      failures: [{ name: 'hello', source: 'git:me/qqbot-plugin-hello@a1b2c3d4e5', error: 'hello 的声明清单与源码不一致（字段：commands）\n详细…' }],
    })
    expect(res.status).toBe(200)
    expect((await managed(call)).plugins[0]).toMatchObject({ buildError: expect.stringContaining('声明清单与源码不一致') })
    const rows = await ledger(call)
    // 同步把 build-9 标成了成功（mock 的构建列表里它是 success）——但错误信息只补不盖，还留着
    expect(rows.every((r) => r.error?.startsWith('插件构建失败：hello（hello 的声明清单与源码不一致（字段：commands））'))).toBe(true)
  })

  it('报告里的 source 已经不是 D1 当前那一份：不记（用户已经换了版本）', async () => {
    const { call } = setup()
    await install(call, { source: 'git:me/qqbot-plugin-hello@f6a7b8c9d0' })
    await report(call, { phase: 'prepare', failures: [{ name: 'hello', source: 'git:me/qqbot-plugin-hello@a1b2c3d4e5', error: '旧版本坏了' }] })
    expect((await managed(call)).plugins[0]!.buildError).toBeNull()
  })

  it('部署阶段失败归不到插件：只记到账本', async () => {
    const { call } = setup()
    await install(call, { source: 'git:me/qqbot-plugin-hello@a1b2c3d4e5' })
    await report(call, { buildUuid: 'build-9', phase: 'deploy', error: '预览地址健康检查失败：HTTP 500' })
    const rows = await ledger(call)
    expect(rows.find((r) => r.action === 'build')?.error).toBe('部署失败：预览地址健康检查失败：HTTP 500')
  })
})

describe('构建机带 build uuid 拉清单', () => {
  it('精确对上触发这次构建的记录；推送触发的构建（账本里没有）返回 null', async () => {
    const { call } = setup()
    await install(call, { source: 'git:me/qqbot-plugin-hello@a1b2c3d4e5' })
    const pull = async (uuid: string) =>
      ((await (await call('/admin/build-manifest', { headers: { authorization: `Bearer ${BUILD_TOKEN}`, 'x-build-uuid': uuid } })).json()) as {
        pendingBuild: { buildUuid: string } | null
      }).pendingBuild
    expect(await pull('build-9')).toMatchObject({ buildUuid: 'build-9' })
    expect(await pull('push-build-1')).toBeNull()
  })
})

describe('GET /admin/status 的新字段', () => {
  it('出处、卸载待生效、依赖关系；配置用默认值打底', async () => {
    const { call, env } = setup({}, [
      deployed('greeter', { source: 'git:me/qqbot-plugin-greeter@a0b1c2d3e4', manifest: { services: ['greet'], defaultConfig: { a: 1, b: 2 } } }),
      deployed('needy', { source: 'git:me/qqbot-plugin-needy@c3d4e5f6a7', manifest: { depends: { greet: '*' } } }),
      deployed('gone', { source: 'git:me/qqbot-plugin-gone@b2c3d4e5f6' }),
    ])
    await install(call, { source: 'git:me/qqbot-plugin-greeter@a0b1c2d3e4', build: false })
    await install(call, { source: 'git:me/qqbot-plugin-needy@c3d4e5f6a7', build: false })
    await env.KV.put('rt:snapshot', JSON.stringify({ revision: 1, plugins: { greeter: { enabled: true, config: { a: 5 } } } }))
    resetSnapshotCache()

    const res = await call('/admin/status', { headers: { authorization: `Bearer ${ADMIN}` } })
    const { plugins } = (await res.json()) as { plugins: Array<Record<string, any>> }
    const byName = Object.fromEntries(plugins.map((p) => [p.name, p]))
    expect(byName.greeter).toMatchObject({
      installed: true,
      removing: false,
      origin: { from: 'd1', source: 'git:me/qqbot-plugin-greeter@a0b1c2d3e4' },
      services: ['greet'],
      dependents: ['needy'],
      // 升级后新增的 b 回落默认值，已保存的 a 保留
      config: { a: 5, b: 2 },
    })
    expect(byName.needy).toMatchObject({ depends: ['greet'], dependents: [] })
    // 线上还在、D1 里没有：卸载还没生效——以前会被当成「仓库内置插件」
    expect(byName.gone).toMatchObject({ installed: false, removing: true })
  })
})

describe('预检列出插件的第三方依赖', () => {
  const ROOT = 'raw.githubusercontent.com/me/qqbot-plugin-deps/a1b2c3d4e5'

  /** 插件仓库里除了声明清单还有哪些文件（package.json、lockfile） */
  function preview(files: Record<string, unknown>) {
    const fetchImpl = createFetchMock({
      [`${ROOT}/manifest.json`]: declaredManifest({ name: 'deps' }),
      ...Object.fromEntries(Object.entries(files).map(([file, body]) => [`${ROOT}/${file}`, body])),
    })
    const runtime = createRuntime({ plugins: [], fetchImpl })
    const env = createEnv({ DB: createManifestD1() })
    return runtime
      .fetch!(
        new Request(`${BASE}/admin/manifest/plugins`, {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify({ source: 'git:me/qqbot-plugin-deps@a1b2c3d4e5', dryRun: true }),
        }),
        env,
        createExecutionContext(),
      )
      .then(async (res) => ({ status: res.status, data: (await res.json()) as { dependencies: Record<string, string>; warnings: string[] } }))
  }

  it('列出 dependencies（框架包与开发依赖不算）；有 lockfile 就不警告', async () => {
    const { status, data } = await preview({
      'package.json': {
        dependencies: { nanoid: '^5.0.0', dayjs: '1.11.13' },
        devDependencies: { '@qqbot/sdk': 'file:../qqbot-workers/packages/sdk', typescript: '^5.9.0' },
      },
      'package-lock.json': { lockfileVersion: 3 },
    })
    expect(status).toBe(200)
    expect(data.dependencies).toEqual({ nanoid: '^5.0.0', dayjs: '1.11.13' })
    expect(data.warnings).toEqual([])
  })

  it('有依赖却没提交 lockfile：提前警告构建会失败（照样能装，由人决定）', async () => {
    const { status, data } = await preview({ 'package.json': { dependencies: { nanoid: '^5.0.0' } } })
    expect(status).toBe(200)
    expect(data.warnings).toEqual([expect.stringContaining('没有 lockfile：构建会失败')])
  })

  it('把 SDK 写进了 dependencies、又有别的依赖：提示挪到 devDependencies', async () => {
    const { data } = await preview({
      'package.json': { dependencies: { nanoid: '^5.0.0', '@qqbot/sdk': '^0.1.0' } },
      'pnpm-lock.yaml': 'lockfileVersion: 9.0',
    })
    expect(data.dependencies).toEqual({ nanoid: '^5.0.0' })
    expect(data.warnings).toEqual([expect.stringContaining('@qqbot/sdk 要移到 devDependencies')])
  })

  it('零依赖（只有开发依赖）或者读不到 package.json：依赖为空，不警告', async () => {
    const zero = await preview({ 'package.json': { devDependencies: { '@qqbot/sdk': '^0.1.0' } } })
    expect(zero.data).toMatchObject({ dependencies: {}, warnings: [] })
    const missing = await preview({})
    expect(missing.status).toBe(200)
    expect(missing.data).toMatchObject({ dependencies: {}, warnings: [] })
  })
})
