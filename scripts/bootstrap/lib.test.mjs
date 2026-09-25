import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BootstrapError,
  buildsConnectUrl,
  listWorkerSecretNames,
  MANIFEST_PLUGINS_TABLE,
  readInstalledPlugins,
  renderSummary,
  resolveBuildToken,
  verifyToken,
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
    webhookUrl: 'https://qqbot.sub.workers.dev/webhook',
    manifestUrl: 'https://qqbot.sub.workers.dev/admin/build-manifest',
    adminToken: 'admin',
    buildToken: null,
    buildTokenReused: true,
    resources: {},
    buildsTokenWritten: false,
    triggerConfigured: false,
    qqSaved: false,
    warnings: [],
  }

  it.each([true, false])('redactSecrets=%s：不会把 null 当令牌印出来，并说明沿用', (redactSecrets) => {
    const md = renderSummary(result, { redactSecrets })
    expect(md).not.toContain('MANIFEST_TOKEN=null')
    expect(md).toContain('本次沿用、没有轮换')
  })
})
