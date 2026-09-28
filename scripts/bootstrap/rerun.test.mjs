import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BUILD_COMMAND,
  BUILD_PATH_EXCLUDES,
  DEPLOY_COMMAND,
  deployEnv,
  inspectWorker,
  latestBuildOutcome,
  listTriggerEnv,
  planTriggerSetup,
  renderSummary,
  runBootstrap,
  setTriggerEnv,
} from './lib.mjs'

const ok = (result) => new Response(JSON.stringify({ success: true, errors: [], result }))
const fail = (status, code, message) => new Response(JSON.stringify({ success: false, errors: [{ code, message }], result: null }), { status })

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

afterEach(() => vi.unstubAllGlobals())

describe('重跑引导：先看 Worker 部署过没有', () => {
  it('脚本不存在（404）= 首次部署；有就列出 secret 名；其余失败照常抛', async () => {
    stubFetch(fail(404, 10007, 'workers.api.error.script_not_found'))
    expect(await inspectWorker('tok', 'acc', 'qqbot')).toEqual({ exists: false, secretNames: [] })
    stubFetch(ok([{ name: 'ADMIN_TOKEN' }, { name: 'CF_BUILDS_TOKEN' }]))
    expect(await inspectWorker('tok', 'acc', 'qqbot')).toEqual({ exists: true, secretNames: ['ADMIN_TOKEN', 'CF_BUILDS_TOKEN'] })
    stubFetch(fail(403, 10000, 'Authentication error'))
    await expect(inspectWorker('tok', 'acc', 'qqbot')).rejects.toThrow('Authentication error')
  })

  it('首次部署走 wrangler 建脚本；重跑走带健康检查的路径，并同步 Cron 与 workers.dev', () => {
    const first = deployEnv({ token: 't', accountId: 'a', workerName: 'qqbot', bindings: { kvId: 'kv', d1Id: 'd1', r2Name: 'r2' } })
    expect(first).toMatchObject({ INITIAL_BOOTSTRAP: 'true', CF_KV_ID: 'kv', CF_D1_ID: 'd1', CF_R2_NAME: 'r2' })
    expect(first.BOOTSTRAP_REDEPLOY).toBeUndefined()
    const again = deployEnv({ token: 't', accountId: 'a', workerName: 'qqbot', bindings: { kvId: 'kv' }, redeploy: true })
    expect(again).toMatchObject({ BOOTSTRAP_REDEPLOY: 'true' })
    expect(again.INITIAL_BOOTSTRAP).toBeUndefined()
  })

  it('没有 D1 / R2（none、R2 降级）明确传 none：缺省会被部署护栏当成「没解析出来」拒绝', () => {
    expect(deployEnv({ token: 't', accountId: 'a', bindings: { kvId: 'kv' }, redeploy: true })).toMatchObject({ CF_D1_ID: 'none', CF_R2_NAME: 'none' })
  })

  it('沿用原密码时不在远端操作之前拦——得先查 Worker 上有没有；没沿用照旧当场拒绝', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('网络不通')
    })
    vi.stubGlobal('fetch', fetchSpy)
    await expect(runBootstrap({ token: 'tok', keepAdminToken: true, repoRoot: '/x' })).rejects.toThrow(/网络错误/)
    expect(fetchSpy).toHaveBeenCalled()
    fetchSpy.mockClear()
    await expect(runBootstrap({ token: 'tok', repoRoot: '/x' })).rejects.toThrow(/缺少管理密钥/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('重跑时连接仓库这一步做哪些事', () => {
  const trigger = { uuid: 'tr', branch: 'main', pathExcludes: [...BUILD_PATH_EXCLUDES], buildCommand: BUILD_COMMAND, deployCommand: DEPLOY_COMMAND, buildCaching: true }
  const env = { MANIFEST_URL: { value: 'https://m', isSecret: false }, MANIFEST_TOKEN: { value: null, isSecret: true } }

  it('配置全都一致、上次构建成功：什么都不写，也不补跑', () => {
    expect(planTriggerSetup({ trigger, env, manifestUrl: 'https://m', buildToken: null, lastOutcome: 'success' })).toEqual({
      updateSettings: false,
      updateUrl: false,
      manifestToken: 'keep',
      startBuild: false,
    })
  })

  it('命令变了（破坏性更新之后重跑）：改命令、补跑一次；MANIFEST_TOKEN 对得上就不换', () => {
    const plan = planTriggerSetup({ trigger: { ...trigger, buildCommand: 'old' }, env, manifestUrl: 'https://m', buildToken: null, lastOutcome: 'success' })
    expect(plan).toMatchObject({ updateSettings: true, updateUrl: false, manifestToken: 'keep', startBuild: true })
  })

  it('上次构建没成功、trigger 上没有 MANIFEST_TOKEN、或读不到现状：换一个新值并补跑', () => {
    expect(planTriggerSetup({ trigger, env, manifestUrl: 'https://m', buildToken: null, lastOutcome: 'failure' }).manifestToken).toBe('rotate')
    expect(planTriggerSetup({ trigger, env: { MANIFEST_URL: env.MANIFEST_URL }, manifestUrl: 'https://m', buildToken: null, lastOutcome: 'success' }).manifestToken).toBe('rotate')
    expect(planTriggerSetup({ trigger: { ...trigger, buildCommand: undefined }, env: null, manifestUrl: 'https://m', buildToken: null, lastOutcome: null })).toEqual({
      updateSettings: true,
      updateUrl: true,
      manifestToken: 'rotate',
      startBuild: true,
    })
  })

  it('这次手里有 BUILD_TOKEN 的值（首次、显式给了）就照写；清单地址变了只改地址', () => {
    expect(planTriggerSetup({ trigger, env, manifestUrl: 'https://m', buildToken: 'bt', lastOutcome: 'success' }).manifestToken).toBe('write')
    expect(planTriggerSetup({ trigger, env, manifestUrl: 'https://new', buildToken: null, lastOutcome: 'success' })).toMatchObject({ updateUrl: true, manifestToken: 'keep', startBuild: true })
  })

  it('读 trigger 变量与最近一次构建；只写给了的那个变量', async () => {
    const calls = stubFetch(
      ok({ MANIFEST_URL: { value: 'https://m', is_secret: false }, MANIFEST_TOKEN: { value: null, is_secret: true } }),
      ok([
        { build_outcome: 'failure', created_on: '2026-09-01T00:00:00Z', trigger: { trigger_uuid: 'tr' } },
        { build_outcome: 'success', created_on: '2026-09-02T00:00:00Z', trigger: { trigger_uuid: 'tr' } },
        { build_outcome: 'failure', created_on: '2026-09-03T00:00:00Z', trigger: { trigger_uuid: 'preview' } },
      ]),
      ok({}),
    )
    expect(await listTriggerEnv('tok', 'acc', 'tr')).toEqual({ MANIFEST_URL: { value: 'https://m', isSecret: false }, MANIFEST_TOKEN: { value: null, isSecret: true } })
    // 预览 trigger 的构建不算；按时间取最新
    expect(await latestBuildOutcome('tok', 'acc', 'tag', 'tr')).toBe('success')
    await setTriggerEnv('tok', 'acc', 'tr', { manifestUrl: 'https://new' })
    expect(calls[1].url).toContain('/builds/workers/tag/builds')
    expect(calls[2].body).toEqual({ MANIFEST_URL: { value: 'https://new', is_secret: false } })
  })
})

describe('重跑后的汇总', () => {
  const base = {
    panelUrl: 'https://qqbot.x.workers.dev/',
    manifestUrl: 'https://qqbot.x.workers.dev/admin/build-manifest',
    buildToken: null,
    buildTokenReused: true,
    resources: { kv: { name: 'qqbot', created: false }, d1: null, r2: null },
    buildsTokenWritten: false,
    triggerConfigured: true,
    warnings: [],
    accountId: 'acc',
    workerName: 'qqbot',
  }

  it('Worker 上已有的构建 token 算沿用，不再报「尚未配置」', () => {
    const md = renderSummary({ ...base, buildsTokenExisting: true }, { publicView: true })
    expect(md).toContain('沿用 Worker 上已有的那个')
    expect(md).not.toContain('尚未配置 `CF_BUILDS_TOKEN`')
    expect(renderSummary(base, { publicView: true })).toContain('尚未配置 `CF_BUILDS_TOKEN`')
  })

  it('重跑有自己的标题与说明；沿用原密码时不教人重设', () => {
    const md = renderSummary({ ...base, redeployed: true, adminTokenKept: true }, { publicView: true })
    expect(md).toContain('## ✅ 重新部署完成')
    expect(md).toContain('带健康检查')
    expect(md).toContain('沿用原来的 `ADMIN_TOKEN`')
    expect(md).not.toContain('wrangler secret put ADMIN_TOKEN')
  })
})
