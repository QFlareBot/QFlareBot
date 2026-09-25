#!/usr/bin/env node
/**
 * 网页引导：起本地 HTTP 服务 + Cloudflare Quick Tunnel，把向导页暴露出去。
 * 用户在 run 页 Summary 里点隧道链接 → 网页上创建/粘贴 token → 建资源 → 部署 →
 * 创建构建 token → 连接仓库，全程跟着页面走。连接完成后构建命令与清单环境变量
 * 由向导经 Builds API 写进 trigger，Cloudflare 后台不需要手填任何格子。
 *
 * 安全边界：
 * - token 只在本进程内存里，收到即输出 ::add-mask::（Actions 日志自动打码）
 * - Quick Tunnel 是随机不可猜 URL + HTTPS，但本质是临时公开入口——向导结束后即关闭
 * - 进程在完成或 40 分钟无活动后退出
 *
 * API（全部 JSON）：
 *   GET  /api/init                   页面初始数据（默认值、token 预填链接）
 *   POST /api/verify                 { token, accountId? } 验证主 token + 权限试探
 *   POST /api/qq-bind/start          扫码创建 QQ 机器人：建绑定任务，返回二维码 SVG（密钥留在本进程）
 *   POST /api/qq-bind/poll           轮询一次；扫码完成后凭证留在本进程，部署时自动存进 KV
 *   POST /api/provision              表单提交，启动引导（异步）
 *   GET  /api/progress               进度轮询
 *   GET  /api/builds-status          仓库是否已连接 Workers Builds
 *   POST /api/complete               { buildsToken? } 写入构建凭证、配置构建 trigger 并收尾退出
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile, writeFile, chmod } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderSVG } from 'uqr'
import {
  adminTokenProblem,
  BootstrapError,
  BUILD_COMMAND,
  cfFetch,
  createQQBindTask,
  DEPLOY_COMMAND,
  listAccounts,
  pollQQBindResult,
  probePermissions,
  renderSummary,
  runBootstrap,
  SETUP_TOKEN_URL,
  verifyToken,
  writeSecrets,
} from './lib.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PORT = Number(process.env.PORT || 8787)
const IDLE_TIMEOUT_MS = 40 * 60 * 1000
const CLAIM_TIMEOUT_MS = 15 * 60 * 1000

const sessionId = randomBytes(16).toString('hex')
let claimedCookie = null
let claimTimer = null

const env = process.env
const state = {
  token: null,
  accountId: env.BOOT_ACCOUNT_ID?.trim() || null,
  accounts: [],
  workerName: env.BOOT_WORKER_NAME?.trim() || 'qqbot',
  provision: null, // { lines: [], done, ok, error, result }
  qqBind: null, // 进行中的扫码任务 { taskId, key }
  qqBound: null, // 扫码拿到的凭证 { appId, secret }，不下发给浏览器
  completed: false,
  completeTimer: null,
  lastActivity: Date.now(),
}

function parseCookies(req) {
  const list = {}
  const rc = req.headers.cookie
  if (rc) {
    for (const cookie of rc.split(';')) {
      const parts = cookie.split('=')
      if (parts.length >= 2) {
        list[parts[0].trim()] = decodeURIComponent(parts.slice(1).join('=').trim())
      }
    }
  }
  return list
}

function log(line) {
  console.log(`[wizard] ${line}`)
}

function mask(value) {
  if (value) console.log(`::add-mask::${value}`)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > 1024 * 1024) reject(new Error('请求体过大'))
    })
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** 表单手填优先；AppSecret 留空且 AppID 与扫码结果一致（或也留空）时用扫码拿到的凭证 */
function resolveQQ(body) {
  const appId = typeof body.qqAppId === 'string' ? body.qqAppId.trim() : ''
  const secret = typeof body.qqSecret === 'string' ? body.qqSecret.trim() : ''
  if (appId && secret) return { appId, secret }
  if (!secret && state.qqBound && (!appId || appId === state.qqBound.appId)) return state.qqBound
  return undefined
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * 仓库连上之后，把构建配置直接写进 trigger。
 *
 * Build command / Deploy command / MANIFEST_URL / MANIFEST_TOKEN 这四项以前只出现在
 * GITHUB_STEP_SUMMARY 的照抄块里——而向导用户这时候早就离开那个页面了，结果是：
 * 走完向导 → 去面板装插件 → 构建机用默认命令跑 → 失败，面板上只显示「失败」。
 *
 * 这里用的正是构建 token 自带的 Workers Builds Configuration (Edit) 权限，
 * 不需要用户额外授权，也不需要多输入任何东西。
 */
async function configureTrigger(buildsToken, accountId, triggerUuid, { manifestUrl, buildToken }) {
  await cfFetch(buildsToken, `/accounts/${accountId}/builds/triggers/${triggerUuid}`, {
    method: 'PATCH',
    body: { build_command: BUILD_COMMAND, deploy_command: DEPLOY_COMMAND },
  })
  await cfFetch(buildsToken, `/accounts/${accountId}/builds/triggers/${triggerUuid}/environment_variables`, {
    method: 'PATCH',
    body: {
      MANIFEST_URL: { value: manifestUrl, is_secret: false },
      MANIFEST_TOKEN: { value: buildToken, is_secret: true },
    },
  })
}

/**
 * 列某个 Worker 的 Builds trigger。
 *
 * 构建 token 能列脚本、却在这里 403（[10000] Authentication error），几乎一定是缺
 * Workers Builds Configuration 权限——预填链接没把它勾上时就是这样。原样抛出那句
 * Authentication error 等于让人自己猜，这里直接点名缺什么、怎么补。
 */
async function listTriggers(buildsToken, accountId, workerTag) {
  try {
    const triggers = await cfFetch(buildsToken, `/accounts/${accountId}/builds/workers/${workerTag}/triggers`)
    return Array.isArray(triggers) ? triggers : triggers?.items ?? []
  } catch (err) {
    if (err instanceof BootstrapError && err.status === 403) {
      throw new BootstrapError(
        '构建 Token 缺少 Workers Builds Configuration（Edit）权限（权限列表里也可能叫 Workers CI）——' +
          '到 Cloudflare 的 API Tokens 页编辑这个 token 补上这项（token 值不变），再回来重新粘贴',
        { status: 403 },
      )
    }
    throw err
  }
}

// ── 隧道 ─────────────────────────────────────────────────────────────────

async function startTunnel() {
  if (process.platform !== 'linux') {
    log('非 Linux 环境（本地试跑）：跳过 Quick Tunnel，直接用本地地址')
    return `http://127.0.0.1:${PORT}`
  }
  const binary = path.join(os.tmpdir(), 'cloudflared')
  log('下载 cloudflared…')
  const res = await fetch('https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64', { redirect: 'follow' })
  if (!res.ok) throw new Error(`下载 cloudflared 失败：HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await writeFile(binary, buf)
  await chmod(binary, 0o700)

  return new Promise((resolveTunnel, rejectTunnel) => {
    const child = spawn(binary, ['tunnel', '--url', `http://127.0.0.1:${PORT}`, '--no-autoupdate'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
      cleanup()
      rejectTunnel(new Error('等待 trycloudflare 地址超时（90秒）'))
    }, 90 * 1000)

    const cleanup = () => {
      clearTimeout(timer)
      child.stdout.off('data', onData)
      child.stderr.off('data', onData)
    }

    const onData = (chunk) => {
      const text = String(chunk)
      const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(text)
      if (match) {
        cleanup()
        child.stdout.resume()
        child.stderr.resume()
        log(`Quick Tunnel 就绪：${match[0]}`)
        resolveTunnel(match[0])
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => {
      cleanup()
      rejectTunnel(new Error(`cloudflared 提前退出（${code}）`))
    })
  })
}

// ── 服务 ─────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  state.lastActivity = Date.now()
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)

  try {
    const cookies = parseCookies(req)
    const clientCookie = cookies.wizard_session
    const sidParam = url.searchParams.get('sid')

    // 页面路由（/ 与 /index.html）
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      if (!claimedCookie) {
        // 尚未认领：校验 sid
        if (sidParam && sidParam === sessionId) {
          claimedCookie = randomBytes(32).toString('hex')
          if (claimTimer) {
            clearTimeout(claimTimer)
            claimTimer = null
          }
          log('向导已被首个浏览器会话成功认领并锁定，已屏蔽其他外部访问')
          const html = await readFile(path.join(repoRoot, 'scripts', 'bootstrap', 'page.html'), 'utf8')
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'set-cookie': `wizard_session=${claimedCookie}; Path=/; HttpOnly; SameSite=Lax`,
          })
          res.end(html)
          return
        }
        res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>访问受限</title><style>body{font-family:sans-serif;background:#202124;color:#e8eaed;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;padding:20px;text-align:center}div{max-width:520px;line-height:1.6}h1{font-size:22px;color:#f28b82}</style></head><body><div><h1>🚫 访问受限</h1><p>缺少有效向导凭证（sid）。请通过 GitHub Actions 运行页面的 Step Summary 打开完整向导链接。</p></div></body></html>`)
        return
      }

      // 已经认领：只允许持有专属 Cookie 的浏览器访问
      if (clientCookie === claimedCookie) {
        const html = await readFile(path.join(repoRoot, 'scripts', 'bootstrap', 'page.html'), 'utf8')
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(html)
        return
      }

      res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>向导已被锁定</title><style>body{font-family:sans-serif;background:#202124;color:#e8eaed;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;padding:20px;text-align:center}div{max-width:520px;line-height:1.6}h1{font-size:22px;color:#f28b82}</style></head><body><div><h1>🔒 向导已被接管并锁定</h1><p>本部署向导已被认领并在其他浏览器会话中进行中。为保护您的账户资产与密钥安全，已屏蔽其他客户端访问。</p></div></body></html>`)
      return
    }

    // 所有 API 接口一律要求已认领且 Cookie 匹配
    if (!claimedCookie || clientCookie !== claimedCookie) {
      return json(res, 403, { error: '未授权：向导已被其他会话接管或会话已失效' })
    }

    if (req.method === 'GET' && url.pathname === '/api/init') {
      json(res, 200, {
        repo: env.REPO ?? '(本地试跑)',
        defaults: {
          workerName: state.workerName,
          kvName: env.BOOT_KV_NAME ?? '',
          d1Name: env.BOOT_D1_NAME ?? '',
          r2Name: env.BOOT_R2_NAME ?? '',
          accountId: state.accountId ?? '',
        },
        setupTokenUrl: SETUP_TOKEN_URL,
        // 连接仓库的表单要照填这两条：默认的 npx wrangler deploy 在这个仓库里跑不通
        buildCommand: BUILD_COMMAND,
        deployCommand: DEPLOY_COMMAND,
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/verify') {
      const body = await readBody(req)
      const token = typeof body.token === 'string' ? body.token.trim() : ''
      if (!token) return json(res, 400, { error: '请粘贴 API token' })
      mask(token)
      const identity = await verifyToken(token)
      const accounts = await listAccounts(token)
      if (body.accountId) state.accountId = body.accountId.trim()
      if (!state.accountId) {
        if (accounts.length === 0) return json(res, 400, { error: 'Token 访问不到任何账户——请确认账户范围包含你的账户' })
        if (accounts.length > 1) {
          return json(res, 400, { error: `Token 能访问 ${accounts.length} 个账户，请在下方选择`, accounts })
        }
        state.accountId = accounts[0].id
      }
      const missing = await probePermissions(token, state.accountId)
      if (missing.length) {
        return json(res, 400, {
          error: `Token 缺少权限：${missing.join('、')}——请按预填链接重新创建（缺什么网页会点名）`,
        })
      }
      state.token = token
      state.accounts = accounts
      json(res, 200, { ok: true, tokenId: identity.id, accountId: state.accountId, accounts })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/qq-bind/start') {
      try {
        const { taskId, key, qrUrl } = await createQQBindTask()
        state.qqBind = { taskId, key }
        json(res, 200, { ok: true, qrUrl, svg: renderSVG(qrUrl, { border: 1 }) })
      } catch (err) {
        json(res, 502, { error: err.message })
      }
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/qq-bind/poll') {
      if (!state.qqBind) return json(res, 400, { error: '先获取二维码' })
      try {
        const r = await pollQQBindResult(state.qqBind.taskId, state.qqBind.key)
        if (r.status !== 'created') return json(res, 200, { ok: true, status: r.status })
        mask(r.secret)
        state.qqBound = { appId: r.appId, secret: r.secret }
        state.qqBind = null
        log(`扫码创建 QQ 机器人成功：AppID ${r.appId}`)
        json(res, 200, { ok: true, status: 'created', appId: r.appId })
      } catch (err) {
        json(res, 502, { error: err.message })
      }
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/provision') {
      if (!state.token) return json(res, 400, { error: '先完成 token 验证' })
      if (state.provision && !state.provision.done) return json(res, 409, { error: '引导已在进行中' })
      const body = await readBody(req)
      // 先校验再开工：前端也拦，但不能只靠前端
      const adminToken = typeof body.adminToken === 'string' ? body.adminToken.trim() : ''
      const adminProblem = adminTokenProblem(adminToken)
      if (adminProblem) return json(res, 400, { error: adminProblem })
      mask(adminToken)
      const lines = []
      const provision = { lines, done: false, ok: false, error: null, result: null }
      state.provision = provision
      const workerName = (body.workerName || state.workerName).trim() || 'qqbot'
      state.workerName = workerName
      if (body.qqSecret) mask(body.qqSecret)
      runBootstrap({
        token: state.token,
        accountId: body.accountId?.trim() || state.accountId,
        workerName,
        kvName: body.kvName?.trim() || undefined,
        d1Name: body.d1Name?.trim() || undefined,
        r2Name: body.r2Name?.trim() || undefined,
        qq: resolveQQ(body),
        buildsToken: null, // 构建 token 在连接仓库后的收尾步骤写入
        adminToken,
        repoRoot,
        onStep: (name, st, detail) => {
          const mark = st === 'ok' ? '✅' : st === 'run' ? '⏳' : st === 'warn' ? '⚠️ ' : '❌'
          lines.push(`${mark} ${name}${detail ? ` — ${detail}` : ''}`)
        },
      })
        .then((result) => {
          provision.result = result
          provision.ok = true
          provision.done = true
          lines.push('✅ 引导完成')
        })
        .catch((err) => {
          provision.error = err instanceof BootstrapError ? err.message : (err?.message ?? String(err))
          provision.hint = err instanceof BootstrapError ? err.hint : undefined
          provision.done = true
          lines.push(`❌ 失败：${provision.error}`)
        })
      json(res, 200, { started: true })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/progress') {
      const p = state.provision
      json(res, 200, p ? { lines: p.lines, done: p.done, ok: p.ok, error: p.error, hint: p.hint ?? null, result: p.result ?? null } : { lines: [], done: false, ok: false })
      return
    }

    if ((req.method === 'POST' || req.method === 'GET') && url.pathname === '/api/builds-status') {
      if (!state.accountId) return json(res, 400, { error: '先完成引导' })
      let buildsToken = ''
      if (req.method === 'POST') {
        const body = await readBody(req)
        if (typeof body.buildsToken === 'string') buildsToken = body.buildsToken.trim()
      } else {
        buildsToken = url.searchParams.get('buildsToken')?.trim() || ''
      }
      if (!buildsToken) {
        return json(res, 200, { ok: false, connected: false, error: '请先粘贴构建 Token' })
      }
      mask(buildsToken)
      try {
        const scripts = await cfFetch(buildsToken, `/accounts/${state.accountId}/workers/scripts`)
        const me = (Array.isArray(scripts) ? scripts : scripts?.items ?? []).find((s) => s?.id === state.workerName)
        if (!me?.tag) return json(res, 200, { ok: false, connected: false, error: `找不到脚本 ${state.workerName}` })
        const items = await listTriggers(buildsToken, state.accountId, me.tag)
        json(res, 200, { ok: true, connected: items.length > 0, count: items.length })
      } catch (err) {
        json(res, 200, { ok: false, connected: false, error: err.message })
      }
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/complete') {
      if (!state.provision?.ok) return json(res, 400, { error: '引导尚未成功' })
      const body = await readBody(req)
      let buildsTokenWritten = false
      let triggerConfigured = false
      let triggerError = null
      if (body.buildsToken && typeof body.buildsToken === 'string') {
        const buildsToken = body.buildsToken.trim()
        mask(buildsToken)
        // 用构建 token 实际打一次 trigger 列表，验证它真能触发重建，并留下 trigger uuid
        const verify = async () => {
          const scripts = await cfFetch(buildsToken, `/accounts/${state.accountId}/workers/scripts`)
          const me = (Array.isArray(scripts) ? scripts : scripts?.items ?? []).find((s) => s?.id === state.workerName)
          if (!me?.tag) throw new Error(`找不到脚本 ${state.workerName}`)
          const items = await listTriggers(buildsToken, state.accountId, me.tag)
          if (!items.length) throw new Error('仓库尚未连接 Workers Builds（查不到 trigger）——先完成连接仓库一步')
          return items[0].trigger_uuid ?? items[0].uuid ?? items[0].id
        }
        const triggerUuid = await verify()

        // 引导沿用了 Worker 上已有的 BUILD_TOKEN 时手里没有它的值，写不了 trigger 的 MANIFEST_TOKEN。
        // 这里两边都握在手里，就地换一个新值：先写 trigger，成功了才写 Worker；
        // trigger 没写成就两边都不动，原来的值仍然是对齐的
        const { result } = state.provision
        const rotatedBuildToken = result.buildToken ? null : randomBytes(32).toString('base64url')
        mask(rotatedBuildToken)

        // 写构建配置失败不算引导失败：Worker 已经部署好、凭证也写进去了，
        // 用户照 Summary 里的兜底清单手填四项同样能跑，没必要把整个引导推倒。
        if (triggerUuid) {
          try {
            await configureTrigger(buildsToken, state.accountId, triggerUuid, {
              manifestUrl: result.manifestUrl,
              buildToken: result.buildToken ?? rotatedBuildToken,
            })
            triggerConfigured = true
            log('构建配置（命令与清单环境变量）已写入 trigger')
          } catch (err) {
            triggerError = err.message
            log(`写入构建配置失败：${err.message}——Summary 里会给出手填清单`)
          }
        } else {
          triggerError = '拿不到 trigger uuid'
        }

        const rotated = rotatedBuildToken && triggerConfigured
        writeSecrets({
          repoRoot,
          token: state.token,
          accountId: state.accountId,
          workerName: state.workerName,
          secrets: { CF_BUILDS_TOKEN: buildsToken, ...(rotated ? { BUILD_TOKEN: rotatedBuildToken } : {}) },
        })
        buildsTokenWritten = true
        // 记下来：重复点「完成」时直接复用，不会再换一次
        if (rotated) Object.assign(result, { buildToken: rotatedBuildToken, buildTokenReused: false })
      }
      const summary = renderSummary({
        ...state.provision.result,
        buildsTokenWritten,
        triggerConfigured,
      }, { redactSecrets: true })
      if (env.GITHUB_STEP_SUMMARY) {
        await writeFile(env.GITHUB_STEP_SUMMARY, summary + '\n').catch(() => {})
      }
      state.completed = true
      json(res, 200, { ok: true, summary, triggerConfigured, triggerError })
      // 不再 3 秒强杀 Runner，留出 10 分钟窗口供用户查看/复制配置，用户也可在页面点击“完成并退出”立即释放 Runner
      if (state.completeTimer) clearTimeout(state.completeTimer)
      state.completeTimer = setTimeout(() => {
        log('向导完成后超时退出')
        process.exit(0)
      }, 10 * 60 * 1000).unref()
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/exit') {
      log('收到网页端退出确认，安全关闭工作流服务...')
      json(res, 200, { ok: true, message: '向导已关闭' })
      setTimeout(() => process.exit(0), 1000)
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/cancel') {
      log('收到网页端终止请求，准备停止工作流...')
      if (env.GITHUB_STEP_SUMMARY) {
        await writeFile(
          env.GITHUB_STEP_SUMMARY,
          ['## ⏹️ 引导已主动终止', '', '用户在网页向导中主动取消了部署工作流。', ''].join('\n'),
        ).catch(() => {})
      }
      json(res, 200, { ok: true, message: '工作流已终止' })
      setTimeout(() => process.exit(0), 1000)
      return
    }

    json(res, 404, { error: 'not found' })
  } catch (err) {
    log(`请求失败：${err.message}`)
    json(res, 500, { error: err.message })
  }
})

// ── 启动 ─────────────────────────────────────────────────────────────────

server.listen(PORT, '127.0.0.1', async () => {
  log(`向导服务已启动：http://127.0.0.1:${PORT}`)
  try {
    const tunnelUrl = await startTunnel()
    const fullUrl = `${tunnelUrl}/?sid=${sessionId}`
    const notice = `::notice::🚀 引导向导已就绪：${fullUrl} （请在 run 页 Summary 里点开，跟着网页完成部署）`
    console.log(notice)
    if (env.GITHUB_STEP_SUMMARY) {
      await writeFile(
        env.GITHUB_STEP_SUMMARY,
        [
          '## 🚀 网页引导已就绪',
          '',
          `**👉 点这里打开向导：${fullUrl}**`,
          '',
          '> 🔒 **安全保护**：本向导链接包含专属认证凭据，首个打开链接的浏览器将独占控制权并锁定，防止未授权访问。',
          '',
          '在网页上：创建并粘贴 API token → 自定义管理密码与可选项 → 部署 Worker → 连接仓库。',
          '完成后本工作流将保持 10 分钟供查阅配置（也可在页面点击立即安全退出）。也可以在 Secret 里配置 `CLOUDFLARE_API_TOKEN` 后重跑走无 UI 模式。',
          '',
        ].join('\n'),
      )
    }

    claimTimer = setTimeout(() => {
      if (!claimedCookie) {
        log('15 分钟内未被任何浏览器客户端认领，自动超时退出以节约 Actions 配额')
        if (env.GITHUB_STEP_SUMMARY) {
          writeFile(
            env.GITHUB_STEP_SUMMARY,
            ['## ⏱️ 向导已超时关闭', '', '在 15 分钟内未检测到用户打开向导网页，工作流已自动结束并释放 runner 资源。', ''].join('\n'),
          ).catch(() => {})
        }
        process.exit(1)
      }
    }, CLAIM_TIMEOUT_MS)
  } catch (err) {
    log(`隧道启动失败：${err.message}——改用无 UI 模式重跑（配置 CLOUDFLARE_API_TOKEN secret）`)
    process.exit(1)
  }
})

setInterval(() => {
  if (Date.now() - state.lastActivity > IDLE_TIMEOUT_MS) {
    log('空闲超时，退出')
    process.exit(1)
  }
}, 60 * 1000).unref()

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
