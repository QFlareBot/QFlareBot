/** 模拟接口的状态：按时间推演部署进度与仓库连接，节奏接近真实（dev/mockApi.ts 用） */

type Step = { name: string; ms: number; warn?: string; fail?: string }

export const ACCOUNTS = [
  { id: '0f3a9c2e7b5d4e1f8a6c3b2d9e7f1a4c', name: 'Personal' },
  { id: '7c1e5a9b3d2f4e6a8c0b1d3e5f7a9c2b', name: 'Team Workspace' },
]

export function freshState() {
  return {
    verified: false,
    accountId: null as string | null,
    workerName: 'qqbot',
    /** 重跑场景：名叫 qqbot 的 Worker 已经在了，仓库连过、构建 token 有、上次构建成功 */
    rerun: false,
    keptAdminToken: false,
    provision: null as null | { startedAt: number; steps: Step[] },
    connectFrom: null as number | null,
    completion: null as null | Record<string, unknown>,
  }
}
export type MockState = ReturnType<typeof freshState>

export function plan(worker: string, fail: boolean): Step[] {
  return [
    { name: '验证 API Token', ms: 500 },
    { name: '查询账户', ms: 400 },
    { name: '检查 token 权限', ms: 900 },
    { name: '检查是否已经部署过', ms: 400 },
    { name: `准备 KV（${worker}）`, ms: 700 },
    { name: `准备 D1（${worker}）`, ms: 800 },
    { name: `准备 R2（${worker}-artifacts）`, ms: 700, warn: 'Cloudflare API POST /accounts/…/r2/buckets 失败：[10042] Please enable R2 through the Cloudflare Dashboard.' },
    { name: '查询 workers.dev 子域', ms: 400 },
    { name: '读取已安装插件（D1）', ms: 500 },
    { name: '构建并部署 Worker', ms: 12000, ...(fail ? { fail: '命令失败（退出码 1）：pnpm --filter @qqbot/seed run deploy:manifest' } : {}) },
    { name: '写入 Worker 密钥与资源配置', ms: 1100 },
  ]
}

export function existsFor(s: MockState, name: string) {
  if (!s.rerun || name !== 'qqbot') return { workerName: name, exists: false }
  return { workerName: name, exists: true, hasAdminToken: true, hasBuildsToken: true, pluginCount: 3, connected: true }
}

export function result(s: MockState) {
  const w = s.workerName
  const redeployed = s.rerun && w === 'qqbot'
  return {
    accountId: ACCOUNTS[0]!.id,
    workerName: w,
    panelUrl: `https://${w}.example.workers.dev/`,
    manifestUrl: `https://${w}.example.workers.dev/admin/build-manifest`,
    buildsTokenUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    buildsConnectUrl: 'https://dash.cloudflare.com/',
    domainsUrl: 'https://dash.cloudflare.com/',
    buildsUrl: 'https://dash.cloudflare.com/',
    resources: { kv: { name: w, created: !redeployed }, d1: { name: w, created: false }, r2: null },
    warnings: ['R2 不可用（Please enable R2），已降级为不绑定 R2——只有用 ctx.r2 的插件受影响。想启用：先在 Cloudflare 后台激活 R2，再重跑引导'],
    redeployed,
    adminTokenKept: s.keptAdminToken,
    buildsTokenExisting: redeployed,
  }
}

export function progress(s: MockState, now: number) {
  const p = s.provision
  if (!p) return { started: false, steps: [], log: [], done: false, ok: false, now }
  const steps = []
  const log: string[] = []
  let t = p.startedAt
  for (const step of p.steps) {
    const end = t + step.ms
    if (now < t) break
    const finished = now >= end
    const state = !finished ? 'run' : step.fail ? 'fail' : step.warn ? 'warn' : 'ok'
    steps.push({ name: step.name, state, detail: finished ? (step.fail ?? step.warn ?? null) : null, startedAt: t, endedAt: finished ? end : null })
    if (step.name === '构建并部署 Worker') {
      const lines = Math.floor(Math.min(now - t, step.ms) / 180)
      for (let i = 0; i < lines; i++) log.push(i % 9 === 0 ? `> @qqbot/${['sdk', 'runtime', 'ui', 'projector'][i % 4]} build` : `  ✓ step ${i} done in ${(i * 37) % 900}ms`)
      if (finished && step.fail) log.push('✘ [ERROR] A request to the Cloudflare API failed. Authentication error [code: 10000]')
    }
    if (!finished || step.fail) {
      const hint = step.fail ? '检查 token 是否带 Workers Scripts 的编辑权限' : null
      return { started: true, steps, log, done: finished, ok: false, error: step.fail ?? null, hint, result: null, now }
    }
    t = end
  }
  return { started: true, steps, log, done: true, ok: true, error: null, hint: null, result: result(s), now }
}

export function connection(s: MockState, now: number) {
  s.connectFrom ??= now
  // 重跑：一开始就连着、配置没变、不补跑
  if (s.rerun && s.workerName === 'qqbot') {
    return { connected: true, configured: true, unchanged: true, branch: 'main', error: null, buildStarted: false, buildStartedAt: null, buildStatus: null, buildOutcome: null, buildError: null, buildsUrl: 'https://dash.cloudflare.com/', now }
  }
  const since = now - s.connectFrom
  const connected = since > 8000
  const outcome = connected && since > 20000 ? 'success' : null
  return {
    connected,
    configured: connected,
    unchanged: false,
    branch: connected ? 'main' : null,
    error: null,
    buildStarted: connected,
    buildStartedAt: connected ? s.connectFrom + 8500 : null,
    buildStatus: outcome ? 'stopped' : since > 12000 ? 'running' : 'queued',
    buildOutcome: outcome,
    buildError: null,
    buildsUrl: 'https://dash.cloudflare.com/',
    now,
    ...(connected ? {} : { maybeMissingPermission: '主 Token（第 ① 步那个）缺少「Workers 构建配置（编辑）」权限' }),
  }
}

export function resumeStep(s: MockState) {
  if (s.completion) return 'done'
  const p = s.provision && progress(s, Date.now())
  if (p?.ok) return s.connectFrom && connection(s, Date.now()).connected ? 'builds' : 'connect'
  if (p) return 'deploy'
  return s.verified ? 'options' : 'token'
}
