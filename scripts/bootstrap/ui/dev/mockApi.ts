/**
 * `pnpm dev` 用的模拟接口：不碰 Cloudflare，把向导的每一步按真实的节奏走一遍。
 *
 *   Token 填 bad → 缺权限；multi → 要选账户；其余都通过
 *   Worker 名填 fail → 部署在「构建并部署 Worker」失败
 *   构建 Token 填 bad → 验证失败
 *   GET /__mock?scenario=fresh|rerun|connected|done|locked|unclaimed 直接跳到某个状态
 *   （rerun：名叫 qqbot 的 Worker 已经部署过，第 ② 步会提示重新部署）
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { ACCOUNTS, connection, existsFor, freshState, plan, progress, result, resumeStep } from './mockState.js'

let s = freshState()
let gate: 'locked' | 'unclaimed' | null = null

function scenario(name: string) {
  s = freshState()
  gate = name === 'locked' || name === 'unclaimed' ? name : null
  s.rerun = name === 'rerun'
  if (['connected', 'done'].includes(name)) {
    Object.assign(s, { verified: true, accountId: ACCOUNTS[0]!.id, provision: { startedAt: Date.now() - 60_000, steps: plan('qqbot', false) }, connectFrom: Date.now() - 30_000 })
  }
  if (name === 'done') s.completion = { triggerConfigured: true, triggerError: null, buildsTokenWritten: false, buildsTokenKept: false, closesAt: Date.now() + 9 * 60_000 }
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let data = ''
  for await (const chunk of req) data += chunk
  return data ? JSON.parse(data) : {}
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function handle(req: IncomingMessage, send: (status: number, data: unknown) => void) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const now = Date.now()
  if (url.pathname === '/__mock') return (scenario(url.searchParams.get('scenario') ?? 'fresh'), send(200, { ok: true }))
  if (gate) return send(403, { error: gate === 'locked' ? '向导已被其他浏览器接管' : '缺少有效的向导凭证（sid）', gate })
  const route = `${req.method} ${url.pathname}`
  if (route === 'GET /api/init') {
    const resume = { step: resumeStep(s), accountId: s.verified ? s.accountId : null, accountName: s.verified ? 'Personal' : null, workerName: s.workerName, completion: s.completion }
    return send(200, {
      repo: 'someone/QFlareBot',
      defaults: { workerName: 'qqbot', kvName: '', d1Name: '', r2Name: '' },
      setupTokenUrl: 'https://dash.cloudflare.com/profile/api-tokens',
      buildCommand: 'pnpm build && pnpm --filter @qqbot/seed run manifest:prepare',
      deployCommand: 'pnpm --filter @qqbot/seed run manifest:deploy',
      adminTokenMinLength: 12,
      resume,
      closesAt: (s.completion?.closesAt as number | undefined) ?? null,
      now,
    })
  }
  if (route === 'POST /api/verify') {
    const { token, accountId } = (await body(req)) as { token?: string; accountId?: string }
    await wait(900)
    if (token === 'bad') return send(400, { error: 'Token 缺少权限：Workers Scripts（读）、D1（读）——按预填链接重新创建一个', missing: ['workers_scripts', 'd1'] })
    if (token === 'multi' && !accountId) return send(400, { error: `这个 Token 能访问 ${ACCOUNTS.length} 个账户，选一个部署到哪里`, accounts: ACCOUNTS })
    Object.assign(s, { verified: true, accountId: accountId || ACCOUNTS[0]!.id })
    const account = ACCOUNTS.find((a) => a.id === s.accountId)!
    return send(200, { ok: true, accountId: account.id, accountName: account.name })
  }
  if (route === 'GET /api/existing') {
    await wait(700)
    return send(200, existsFor(s, url.searchParams.get('workerName') || 'qqbot'))
  }
  if (route === 'POST /api/provision') {
    const { workerName, adminToken, keepAdminToken } = (await body(req)) as { workerName?: string; adminToken?: string; keepAdminToken?: boolean }
    if (!keepAdminToken && (!adminToken || adminToken.length < 12)) return send(400, { error: '管理密钥至少 12 个字符：面板在公网上，太短的密码容易被猜中' })
    s.workerName = workerName || 'qqbot'
    s.keptAdminToken = !!keepAdminToken
    s.provision = { startedAt: now, steps: plan(s.workerName, s.workerName === 'fail') }
    return send(200, { started: true })
  }
  if (route === 'GET /api/progress') return send(200, progress(s, now))
  if (route === 'GET /api/builds-connection') return send(200, connection(s, now))
  if (route === 'POST /api/builds-token') {
    const { buildsToken } = (await body(req)) as { buildsToken?: string }
    await wait(800)
    if (buildsToken === 'bad') return send(400, { error: '构建 Token 缺少「Workers 脚本（读取）」权限——编辑这个 token 补上（token 值不变）' })
    return send(200, { ok: true })
  }
  if (route === 'POST /api/complete') {
    const { buildsToken } = (await body(req)) as { buildsToken?: string }
    await wait(600)
    const existing = result(s).buildsTokenExisting
    s.completion = {
      triggerConfigured: !!s.connectFrom,
      triggerError: s.connectFrom ? null : '仓库还没连接',
      buildsTokenWritten: !!buildsToken,
      buildsTokenKept: !buildsToken && existing,
      closesAt: now + 10 * 60_000,
    }
    return send(200, { ...s.completion, now })
  }
  if (route === 'POST /api/exit' || route === 'POST /api/cancel') return send(200, { ok: true })
  send(404, { error: 'not found' })
}

export function mockApi(): Plugin {
  return {
    name: 'wizard-mock-api',
    configureServer(server) {
      server.middlewares.use((req, res: ServerResponse, next) => {
        if (!req.url?.startsWith('/api/') && !req.url?.startsWith('/__mock')) return next()
        const send = (status: number, data: unknown) => {
          res.statusCode = status
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify(data))
        }
        handle(req, send).catch((err: Error) => send(500, { error: err.message }))
      })
    },
  }
}
