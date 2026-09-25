import { describe, expect, it } from 'vitest'
import { classifyDeployError, envFromRemoteConfig, manifestPolicy, resolveScriptName, unresolvedBindings } from './deploy-policy.mjs'

describe('unresolvedBindings', () => {
  it('挑出 unresolved，skipped 不算——CF_*=none 是「这个资源不存在」，不是没解析出来', () => {
    expect(unresolvedBindings({ bindings: { kv: 'resolved', d1: 'unresolved', r2: 'skipped' } })).toEqual(['D1'])
  })

  it('全部解析好时为空', () => {
    expect(unresolvedBindings({ bindings: { kv: 'resolved', d1: 'resolved', r2: 'resolved' } })).toEqual([])
  })

  it('D1/R2 同样能被拦下——它们在上传元数据里是「整个绑定不出现」，扫占位符只看得见 KV', () => {
    expect(unresolvedBindings({ bindings: { kv: 'resolved', d1: 'unresolved', r2: 'unresolved' } })).toEqual(['D1', 'R2'])
  })

  it('旧产物没有 bindings 字段 → null，调用方据此拒绝部署而不是当成"没问题"', () => {
    expect(unresolvedBindings({ metadata: {} })).toBeNull()
  })
})

describe('envFromRemoteConfig', () => {
  const full = {
    workerName: 'mybot',
    kvId: 'kv-1',
    d1Id: 'd1-1',
    r2Name: 'mybot-artifacts',
    defaultDomain: 'mybot.sub.workers.dev',
    hasD1: true,
    hasR2: true,
  }

  it('把 build-config 的回答映射成 CF_* 环境变量', () => {
    expect(envFromRemoteConfig(full, {})).toEqual({
      CF_WORKER_NAME: 'mybot',
      CF_KV_ID: 'kv-1',
      CF_D1_ID: 'd1-1',
      CF_R2_NAME: 'mybot-artifacts',
      CF_DEFAULT_DOMAIN: 'mybot.sub.workers.dev',
    })
  })

  it('构建环境里显式设置的优先，不覆盖', () => {
    const env = envFromRemoteConfig(full, { CF_KV_ID: 'mine', CF_R2_NAME: 'none' })
    expect(env).not.toHaveProperty('CF_KV_ID')
    expect(env).not.toHaveProperty('CF_R2_NAME')
    expect(env.CF_D1_ID).toBe('d1-1')
  })

  it('R2 未激活被降级（hasR2 为假、没有桶名）→ CF_R2_NAME=none，部署护栏按跳过放行', () => {
    // 不补的话模板里的 r2_buckets[0] 解析成 unresolved，每一次构建都被护栏拒绝
    const env = envFromRemoteConfig({ ...full, r2Name: null, hasR2: false }, {})
    expect(env.CF_R2_NAME).toBe('none')
  })

  it('D1 选了 none（hasD1 为假）→ CF_D1_ID=none，与 manifestPolicy 的 no-d1 分支配套', () => {
    const env = envFromRemoteConfig({ ...full, d1Id: null, hasD1: false }, {})
    expect(env.CF_D1_ID).toBe('none')
  })

  it('绑着但 secret 没写（id 为 null 而 has* 为真）→ 不补，交给护栏拒绝', () => {
    // 这时补 none 会把真实存在的绑定从新版本里剥掉，env.DB / env.R2 当场消失
    const env = envFromRemoteConfig({ ...full, d1Id: null, r2Name: null }, {})
    expect(env).not.toHaveProperty('CF_D1_ID')
    expect(env).not.toHaveProperty('CF_R2_NAME')
  })

  it('旧版 Worker 没有 has* 字段 → 不猜', () => {
    const env = envFromRemoteConfig({ kvId: 'kv-1', d1Id: null, r2Name: null }, {})
    expect(env).toEqual({ CF_KV_ID: 'kv-1' })
  })

  it('拿不到 build-config → 什么都不补', () => {
    expect(envFromRemoteConfig(null, {})).toEqual({})
  })
})

describe('manifestPolicy', () => {
  const failed = { ok: false, error: 'HTTP 500' }

  it('没配 MANIFEST_URL：跳过，用仓库内置清单', () => {
    expect(manifestPolicy({ skipped: true }, null, {})).toBe('skip')
  })

  it('拉到了就用拉到的', () => {
    expect(manifestPolicy({ ok: true, plugins: [] }, { hasD1: true }, {})).toBe('use-remote')
  })

  it('拉不到且不知道有没有 D1 → 硬失败', () => {
    expect(manifestPolicy(failed, null, {})).toBe('fail')
  })

  it('拉不到但确实没绑 D1 → 继续', () => {
    expect(manifestPolicy(failed, { hasD1: false }, {})).toBe('no-d1')
  })

  it('绑着 D1 只是 CF_D1_ID 没写（d1Id 为 null 而 hasD1 为真）→ 仍然硬失败', () => {
    // 这是最危险的一种：拿 d1Id 去猜会误判成「没有 D1」，然后静默把装好的插件从 Worker 上抹掉
    expect(manifestPolicy(failed, { d1Id: null, hasD1: true }, {})).toBe('fail')
  })

  it('旧版 Worker 没有 hasD1 字段 → 硬失败，不猜', () => {
    expect(manifestPolicy(failed, { d1Id: null }, {})).toBe('fail')
  })

  it('MANIFEST_FALLBACK=1 才显式放行', () => {
    expect(manifestPolicy(failed, { hasD1: true }, { MANIFEST_FALLBACK: '1' })).toBe('forced-fallback')
    expect(manifestPolicy(failed, { hasD1: true }, { MANIFEST_FALLBACK: 'true' })).toBe('fail')
  })
})

describe('resolveScriptName', () => {
  it('取生成配置的 name——模板里的名字是错的来源', () => {
    expect(resolveScriptName({ name: 'mybot' }, {})).toBe('mybot')
  })

  it('环境变量优先', () => {
    expect(resolveScriptName({ name: 'mybot' }, { CF_WORKER_NAME: ' other ' })).toBe('other')
  })

  it('两边都没有 → null，调用方报错而不是瞎猜一个默认名', () => {
    expect(resolveScriptName({}, {})).toBeNull()
  })
})

describe('classifyDeployError', () => {
  const cfError = (status, errors = []) => Object.assign(new Error('x'), { name: 'CloudflareApiError', status, errors })

  it('10007 = 脚本不存在，降级去创建', () => {
    expect(classifyDeployError(cfError(404, [{ code: 10007 }]))).toBe('script-not-found')
  })

  it('401/403 = 凭证权限模型不同，降级重试', () => {
    expect(classifyDeployError(cfError(401))).toBe('credentials')
    expect(classifyDeployError(cfError(403))).toBe('credentials')
  })

  it('其余 Cloudflare 错误上抛，不降级', () => {
    expect(classifyDeployError(cfError(500, [{ code: 10001 }]))).toBe('rethrow')
  })

  it('两个安全阀绝不降级——降级会把它们整个绕过去', () => {
    expect(classifyDeployError(Object.assign(new Error('丢 secret'), { name: 'SecretLossError' }))).toBe('rethrow')
    expect(classifyDeployError(Object.assign(new Error('健康检查失败'), { name: 'HealthCheckError' }))).toBe('rethrow')
  })

  it('普通 Error 也上抛', () => {
    expect(classifyDeployError(new Error('boom'))).toBe('rethrow')
    expect(classifyDeployError(undefined)).toBe('rethrow')
  })
})
