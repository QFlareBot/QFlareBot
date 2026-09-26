import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  adminTokenProblem,
  BootstrapError,
  BUILD_PATH_EXCLUDES,
  buildsConnectUrl,
  buildsTokenUrl,
  cfFetch,
  configureTrigger,
  getBuild,
  listTriggers,
  listWorkerSecretNames,
  MANIFEST_PLUGINS_TABLE,
  pickProductionTrigger,
  readInstalledPlugins,
  redactAccountPath,
  renderSummary,
  resolveBuildToken,
  runBootstrap,
  SETUP_TOKEN_URL,
  startBuild,
  verifyToken,
  workerDashLink,
} from './lib.mjs'

const ok = (result) => new Response(JSON.stringify({ success: true, errors: [], result }))
const d1 = (results) => ok([{ results, success: true, meta: {} }])

/** 按顺序回放响应，并记下每次请求 */
function stubFetch(...responses) {
  const calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined })
      const next = responses.shift()
      if (!next) throw new Error(`多出来的请求：${url}`)
      return next
    }),
  )
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('管理密钥必须自己设置', () => {
  it('缺失或太短都不合格，够长才放行', () => {
    expect(adminTokenProblem(undefined)).toMatch(/缺少管理密钥/)
    expect(adminTokenProblem('')).toMatch(/缺少管理密钥/)
    expect(adminTokenProblem('short-pass1')).toMatch(/至少 12 个字符/)
    expect(adminTokenProblem('long-enough-pass')).toBeNull()
  })

  it('runBootstrap 不合格时在任何远端操作之前就拒绝——不会建资源，更不会代为生成', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('不应发出任何请求')
    })
    vi.stubGlobal('fetch', fetchSpy)
    await expect(runBootstrap({ token: 'tok', repoRoot: '/nonexistent' })).rejects.toThrow(/缺少管理密钥/)
    await expect(runBootstrap({ token: 'tok', adminToken: 'short', repoRoot: '/nonexistent' })).rejects.toThrow(/至少 12 个字符/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('verifyToken', () => {
  it('GET /user/tokens/verify——POST 会被拒（7001 Method POST not available）', async () => {
    const calls = stubFetch(ok({ id: 'tok-1', status: 'active' }))
    await expect(verifyToken('tok')).resolves.toEqual({ id: 'tok-1' })
    expect(calls[0]).toMatchObject({ url: 'https://api.cloudflare.com/client/v4/user/tokens/verify', method: 'GET' })
  })

  it('状态不是 active → 报错', async () => {
    stubFetch(ok({ id: 'tok-1', status: 'disabled' }))
    await expect(verifyToken('tok')).rejects.toBeInstanceOf(BootstrapError)
  })
})

describe('resolveBuildToken', () => {
  it('Worker 上已有 → 沿用，不轮换——trigger 里那份副本不会跟着变，换了构建就 401', () => {
    expect(resolveBuildToken({ explicit: undefined, existingSecretNames: ['ADMIN_TOKEN', 'BUILD_TOKEN'] })).toEqual({
      value: null,
      reused: true,
    })
  })

  it('显式给了（BUILD_TOKEN secret）→ 以它为准，哪怕 Worker 上已有', () => {
    expect(resolveBuildToken({ explicit: 'mine', existingSecretNames: ['BUILD_TOKEN'] })).toEqual({ value: 'mine', reused: false })
  })

  it('首次（Worker 上没有）→ 生成随机长令牌', () => {
    const plan = resolveBuildToken({ explicit: undefined, existingSecretNames: ['ADMIN_TOKEN'] })
    expect(plan.reused).toBe(false)
    expect(plan.value).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
})

describe('readInstalledPlugins', () => {
  it('表还不存在（新库）→ 空集，不再发第二条查询', async () => {
    const calls = stubFetch(d1([]))
    await expect(readInstalledPlugins('tok', 'acc', 'db-1')).resolves.toEqual([])
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.cloudflare.com/client/v4/accounts/acc/d1/database/db-1/query')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].body.params).toEqual([MANIFEST_PLUGINS_TABLE])
  })

  it('读出已安装插件，只保留构建清单那三个字段', async () => {
    const calls = stubFetch(
      d1([{ name: MANIFEST_PLUGINS_TABLE }]),
      d1([{ name: 'weather', version: '1.2.0', source: 'git:a/weather@abc1234', added_at: 1, updated_at: 2 }]),
    )
    await expect(readInstalledPlugins('tok', 'acc', 'db-1')).resolves.toEqual([
      { name: 'weather', version: '1.2.0', source: 'git:a/weather@abc1234' },
    ])
    expect(calls[1].body.sql).toBe(`SELECT name, version, source FROM ${MANIFEST_PLUGINS_TABLE} ORDER BY name`)
  })

  it('D1 查询失败照常抛出——当成空集会让重跑把插件从线上抹掉', async () => {
    stubFetch(new Response(JSON.stringify({ success: false, errors: [{ code: 7500, message: 'boom' }], result: null }), { status: 500 }))
    await expect(readInstalledPlugins('tok', 'acc', 'db-1')).rejects.toBeInstanceOf(BootstrapError)
  })

  it('表名与列和运行时的定义一致', async () => {
    // 引导脚本跑在 pnpm build 之前，import 不到运行时，只能各存一份；这条断言是副本的唯一约束
    const source = await readFile(new URL('../../packages/runtime/src/manifestStore.ts', import.meta.url), 'utf8')
    expect(source).toContain(`const TABLE_PLUGINS = '${MANIFEST_PLUGINS_TABLE}'`)
    expect(source).toContain('SELECT name, version, source FROM ${TABLE_PLUGINS}')
  })
})

describe('listWorkerSecretNames', () => {
  it('只取名字', async () => {
    const calls = stubFetch(ok([{ name: 'ADMIN_TOKEN', type: 'secret_text' }, { name: 'BUILD_TOKEN', type: 'secret_text' }]))
    await expect(listWorkerSecretNames('tok', 'acc', 'my bot')).resolves.toEqual(['ADMIN_TOKEN', 'BUILD_TOKEN'])
    expect(calls[0].url).toBe('https://api.cloudflare.com/client/v4/accounts/acc/workers/scripts/my%20bot/secrets')
  })
})

describe('buildsTokenUrl', () => {
  it('预填 Workers 构建配置（workers_ci，Edit）与 Workers 脚本（Read），账户限定为本账户', () => {
    // workers_builds 不是有效 key：控制台静默忽略，建出来的 token 缺 Builds 权限、列 trigger 必然 403
    const url = new URL(buildsTokenUrl('acc', 'qqbot-builds'))
    expect(JSON.parse(url.searchParams.get('permissionGroupKeys'))).toEqual([
      { key: 'workers_ci', type: 'edit' },
      { key: 'workers_scripts', type: 'read' },
    ])
    expect(url.searchParams.get('accountId')).toBe('acc')
    expect(url.searchParams.get('name')).toBe('qqbot-builds')
  })
})

describe('buildsConnectUrl', () => {
  it('指向 Worker 设置页（Build → Connect），不是构建记录页', () => {
    // /production/builds 只列构建记录，用户到了那里找不到填构建命令的连接表单
    expect(buildsConnectUrl('acc', 'my bot')).toBe('https://dash.cloudflare.com/acc/workers/services/view/my%20bot/production/settings')
  })
})

describe('renderSummary：沿用 BUILD_TOKEN', () => {
  const result = {
    accountId: 'acc',
    workerName: 'qqbot',
    baseUrl: 'https://qqbot.sub.workers.dev',
    defaultDomain: 'qqbot.sub.workers.dev',
    panelUrl: 'https://qqbot.sub.workers.dev/',
    manifestUrl: 'https://qqbot.sub.workers.dev/admin/build-manifest',
    buildToken: null,
    buildTokenReused: true,
    resources: {},
    buildsTokenWritten: false,
    triggerConfigured: false,
    warnings: [],
  }

  it.each([true, false])('redactSecrets=%s：不会把 null 当令牌印出来，并说明沿用', (redactSecrets) => {
    const md = renderSummary(result, { redactSecrets })
    expect(md).not.toContain('MANIFEST_TOKEN=null')
    expect(md).toContain('本次沿用、没有轮换')
  })
})

describe('renderSummary：地址与密钥', () => {
  const base = {
    accountId: 'acc',
    workerName: 'qqbot',
    panelUrl: 'https://qqbot.sub.workers.dev/',
    manifestUrl: 'https://qqbot.sub.workers.dev/admin/build-manifest',
    buildToken: 'build-token-value',
    buildTokenReused: false,
    resources: {},
    buildsTokenWritten: true,
    triggerConfigured: true,
    warnings: [],
  }

  it('面板地址是可点的链接', () => {
    const md = renderSummary(base, { redactSecrets: true })
    expect(md).toContain('[https://qqbot.sub.workers.dev/](https://qqbot.sub.workers.dev/)')
  })

  it('不给 workers.dev 的回调地址（QQ 开放平台访问不到），先要求绑定自定义域名', () => {
    const md = renderSummary(base, { redactSecrets: true })
    expect(md).not.toContain('workers.dev/webhook')
    expect(md).toContain('https://你的域名/webhook')
    const domainStep = md.indexOf('绑定自定义域名（必需）')
    expect(domainStep).toBeGreaterThan(-1)
    expect(domainStep).toBeLessThan(md.indexOf('创建或绑定 QQ 机器人'))
  })

  it('QQ 机器人在部署之后到面板里创建或绑定', () => {
    const md = renderSummary(base, { redactSecrets: true })
    expect(md).toMatch(/创建或绑定 QQ 机器人\*\*：用新域名打开面板，到「设置」里/)
  })

  it('管理密钥不出现在汇总里，哪怕调用方误传了', () => {
    const md = renderSummary({ ...base, adminToken: 'secret-admin-pass' }, { redactSecrets: false })
    expect(md).not.toContain('secret-admin-pass')
    expect(md).toContain('ADMIN_TOKEN')
  })
})

describe('renderSummary：公开版（写进 Step Summary）', () => {
  // 公开仓库的 Summary 谁都能看，add-mask 也管不到它：地址、账户、资源标识一律不写
  const result = {
    accountId: '0123456789abcdef0123456789abcdef',
    workerName: 'qqbot',
    panelUrl: 'https://qqbot.secret-sub.workers.dev/',
    manifestUrl: 'https://qqbot.secret-sub.workers.dev/admin/build-manifest',
    buildToken: 'build-token-value',
    buildTokenReused: false,
    resources: {
      kv: { name: 'my-kv', id: 'kv-id-123', created: true },
      d1: { name: 'my-d1', id: 'd1-id-456', created: false },
    },
    buildsTokenWritten: false,
    triggerConfigured: false,
    warnings: [],
  }

  it.each([false, true])('triggerConfigured=%s：不含子域、账户 ID、资源名与 id、令牌', (triggerConfigured) => {
    const md = renderSummary({ ...result, triggerConfigured }, { publicView: true })
    for (const leak of ['secret-sub', result.accountId, 'my-kv', 'kv-id-123', 'my-d1', 'd1-id-456', 'build-token-value']) {
      expect(md).not.toContain(leak)
    }
    expect(md).toContain('https://dash.cloudflare.com/?to=/:account/workers/services/view/qqbot/production/settings')
    expect(md).toContain('| KV | （新建） |')
  })

  it('手填清单里的 MANIFEST_URL 只给占位，并带上排除路径', () => {
    const md = renderSummary(result, { publicView: true })
    expect(md).toContain('MANIFEST_URL=https://qqbot.<你的子域>.workers.dev/admin/build-manifest')
    expect(md).toContain(BUILD_PATH_EXCLUDES.join('  '))
  })

  it('完整版（向导页面用）照常带地址', () => {
    expect(renderSummary(result)).toContain('https://qqbot.secret-sub.workers.dev/admin/build-manifest')
  })
})

describe('公开日志里不带账户标识', () => {
  it('redactAccountPath 去掉路径里的账户 ID', () => {
    expect(redactAccountPath('/accounts/0123abc/workers/scripts?per_page=1')).toBe('/accounts/…/workers/scripts?per_page=1')
    expect(redactAccountPath('/user/tokens/verify')).toBe('/user/tokens/verify')
  })

  it('cfFetch 的报错不带账户 ID', async () => {
    stubFetch(new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'denied' }], result: null }), { status: 403 }))
    const err = await cfFetch('tok', '/accounts/0123abc/d1/database').catch((e) => e)
    expect(err.message).toBe('Cloudflare API GET /accounts/…/d1/database 失败：[10000] denied')
  })

  it('多账户时报错不列账户名与 id，改教用 secret 指定', async () => {
    stubFetch(
      ok({ id: 'tok-1', status: 'active' }),
      ok([
        { id: 'aaaa1111', name: '张三的账户' },
        { id: 'bbbb2222', name: 'Team' },
      ]),
    )
    const err = await runBootstrap({ token: 'tok', adminToken: 'long-enough-pass', repoRoot: '/nonexistent' }).catch((e) => e)
    expect(err.message).toBe('Token 能访问 2 个账户，需要指定用哪一个')
    expect(`${err.message} ${err.hint}`).not.toMatch(/aaaa1111|bbbb2222|张三|Team/)
    expect(err.hint).toContain('CLOUDFLARE_ACCOUNT_ID')
  })

  it('workerDashLink 用 :account 占位，不带账户 ID', () => {
    expect(workerDashLink('my bot', 'builds')).toBe('https://dash.cloudflare.com/?to=/:account/workers/services/view/my%20bot/production/builds')
  })
})

describe('主 token 预填链接', () => {
  it('带上 Workers 构建配置（编辑）：第 ④ 步要用主 token 检测连接、写构建配置', () => {
    const groups = JSON.parse(new URL(SETUP_TOKEN_URL).searchParams.get('permissionGroupKeys'))
    expect(groups).toContainEqual({ key: 'workers_ci', type: 'edit' })
    expect(groups).toContainEqual({ key: 'workers_scripts', type: 'edit' })
  })
})

describe('pickProductionTrigger', () => {
  it('跳过排在前面的预览 trigger（开了非生产分支构建时 Cloudflare 另建的那个）', () => {
    const triggers = [
      { trigger_uuid: 'preview', branch_includes: ['*'], branch_excludes: ['main'] },
      { trigger_uuid: 'prod', branch_includes: ['main'], branch_excludes: [] },
    ]
    expect(pickProductionTrigger(triggers)).toEqual({ uuid: 'prod', branch: 'main', pathExcludes: [] })
  })

  it('生产分支按 trigger 实际配置取，不写死 main；带上现有的排除路径', () => {
    expect(pickProductionTrigger([{ trigger_uuid: 't', branch_includes: ['master'], path_excludes: ['notes/*', 1] }])).toEqual({
      uuid: 't',
      branch: 'master',
      pathExcludes: ['notes/*'],
    })
  })

  it('只有预览 trigger 或列表为空时返回 null；缺 branch_includes 字段时按生产处理', () => {
    expect(pickProductionTrigger([{ trigger_uuid: 'preview', branch_includes: ['*'] }])).toBeNull()
    expect(pickProductionTrigger([])).toBeNull()
    expect(pickProductionTrigger([{ uuid: 'u' }])).toEqual({ uuid: 'u', branch: 'main', pathExcludes: [] })
  })
})

describe('Workers Builds 调用', () => {
  const fail = (status, code, message) =>
    new Response(JSON.stringify({ success: false, errors: [{ code, message }], result: null }), { status })

  it('listTriggers：404 当作还没连接；403 点名缺哪个权限并打上 missingPermission', async () => {
    stubFetch(fail(404, 12004, 'not found'))
    expect(await listTriggers('tok', 'acc', 'tag', '主 Token')).toEqual([])

    stubFetch(fail(403, 10000, 'Authentication error'))
    const err = await listTriggers('tok', 'acc', 'tag', '构建 Token ').catch((e) => e)
    expect(err).toBeInstanceOf(BootstrapError)
    expect(err.missingPermission).toBe(true)
    expect(err.message).toMatch(/^构建 Token 缺少「Workers 构建配置（编辑）」权限/)

    stubFetch(fail(500, 1, 'boom'))
    await expect(listTriggers('tok', 'acc', 'tag', '主 Token')).rejects.toThrow('boom')
  })

  it('configureTrigger 写命令、排除路径与清单变量；startBuild 按分支触发；getBuild 读状态', async () => {
    const calls = stubFetch(ok({}), ok({}), ok({ build_uuid: 'b1' }), ok({ status: 'running', build_outcome: null }))
    await configureTrigger('tok', 'acc', 'trig', { manifestUrl: 'https://x/admin/build-manifest', buildToken: 'bt', pathExcludes: ['notes/*'] })
    expect(await startBuild('tok', 'acc', 'trig', 'main')).toBe('b1')
    expect(await getBuild('tok', 'acc', 'b1')).toEqual({ status: 'running', outcome: '' })
    expect(calls.map((c) => `${c.method} ${c.url.replace('https://api.cloudflare.com/client/v4', '')}`)).toEqual([
      'PATCH /accounts/acc/builds/triggers/trig',
      'PATCH /accounts/acc/builds/triggers/trig/environment_variables',
      'POST /accounts/acc/builds/triggers/trig/builds',
      'GET /accounts/acc/builds/builds/b1',
    ])
    // 用户在后台自己加的排除路径（notes/*）留着，补上本项目的
    expect(calls[0].body.path_excludes).toEqual(['notes/*', ...BUILD_PATH_EXCLUDES])
    expect(calls[1].body).toEqual({
      MANIFEST_URL: { value: 'https://x/admin/build-manifest', is_secret: false },
      MANIFEST_TOKEN: { value: 'bt', is_secret: true },
    })
    expect(calls[2].body).toEqual({ branch: 'main' })
  })
})
