#!/usr/bin/env node
/**
 * 网页引导：起本地 HTTP 服务 + Cloudflare Quick Tunnel，把向导页暴露出去。
 * 用户在 run 页 Summary 里点隧道链接 → 网页上创建/粘贴 token → 建资源 → 部署 →
 * 连接仓库 → 创建构建 token，全程跟着页面走。连接由向导用主 token 自动检测，检测到就把
 * 构建命令与清单环境变量写进 trigger、补跑一次构建，Cloudflare 后台不需要手填任何格子。
 *
 * 安全边界：
 * - token 只在本进程内存里，收到即输出 ::add-mask::（Actions 日志自动打码）
 * - 账户 ID、workers.dev 子域、资源 id 同样打码；它们与面板地址只在向导页面上显示，
 *   写进 Step Summary 的是 publicView 版本（公开仓库的 Summary 谁都能看，add-mask 管不到它）
 * - Quick Tunnel 是随机不可猜 URL + HTTPS，但本质是临时公开入口——向导结束后即关闭
 * - 进程在完成或 40 分钟无活动后退出
 *
 * QQ 机器人不在向导里建：部署完到面板「设置」里扫码创建或填入凭证。
 *
 * API（全部 JSON）：
 *   GET  /api/init                   页面初始数据（默认值、token 预填链接）
 *   POST /api/verify                 { token, accountId? } 验证主 token + 权限试探
 *   POST /api/provision              表单提交，启动引导（异步）
 *   GET  /api/progress               进度轮询
 *   GET  /api/builds-connection      连接检测轮询：连上即写构建配置、补跑构建；之后报构建进度
 *   POST /api/builds-token           { buildsToken } 验证构建 token（连接之后才有意义）
 *   POST /api/complete               { buildsToken? } 写入构建凭证并收尾退出
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile, writeFile, chmod } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  adminTokenProblem,
  BootstrapError,
  BUILD_COMMAND,
  configureTrigger,
  DEPLOY_COMMAND,
  findWorkerTag,
  getBuild,
  listAccounts,
  listTriggers,
  pickProductionTrigger,
  probePermissions,
  renderSummary,
  runBootstrap,
  SETUP_TOKEN_URL,
  startBuild,
  verifyToken,
  workerBuildsUrl,
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
  builds: null, // 检测到仓库连接后：{ tag, trigger: { uuid, branch, pathExcludes }, configured, error, buildUuid, build, buildError, apiToken }
  buildsBusy: null, // 进行中的连接检测（轮询会并发打进来）
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

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * 仓库连上之后一次做完：把构建命令与清单环境变量写进 trigger → 补跑一次构建。
 *
 * 连接那一刻 Cloudflare 若自己跑了一次构建，用的是表单里的命令、也还没有清单变量，注定失败；
 * 配好之后补跑这一次，用户当场就能看到构建链路通不通，不用等到面板里装插件。
 *
 * `token` 平时是主 token（第 ④ 步检测到连接时）；主 token 没写成时，「完成引导」会拿构建 token
 * 再试一次——两者都带 Workers 构建配置权限。写配置失败不算引导失败：Worker 已经部署好，
 * Summary 里有手填清单。
 */
async function setupTrigger(token) {
  const b = state.builds
  const { result } = state.provision
  // 引导沿用了 Worker 上已有的 BUILD_TOKEN 时手里没有它的值，写不了 trigger 的 MANIFEST_TOKEN。
  // 就地换一个新值：先写 trigger，成功了才写 Worker；trigger 没写成就两边都不动，原来的值仍然对齐
  const rotated = result.buildToken ? null : randomBytes(32).toString('base64url')
  mask(rotated)
  try {
    await configureTrigger(token, state.accountId, b.trigger.uuid, {
      manifestUrl: result.manifestUrl,
      buildToken: result.buildToken ?? rotated,
      pathExcludes: b.trigger.pathExcludes,
    })
    if (rotated) {
      writeSecrets({ repoRoot, token: state.token, accountId: state.accountId, workerName: state.workerName, secrets: { BUILD_TOKEN: rotated } })
      Object.assign(result, { buildToken: rotated, buildTokenReused: false })
    }
  } catch (err) {
    b.error = `写入构建配置失败：${err.message}`
    log(b.error)
    return
  }
  b.configured = true
  b.error = null
  b.apiToken = token // 查构建进度沿用写得进配置的这个 token
  log('构建配置（命令、清单环境变量与排除路径）已写入 trigger')
  try {
    b.buildUuid = await startBuild(token, state.accountId, b.trigger.uuid, b.trigger.branch)
    log(`已触发构建（分支 ${b.trigger.branch}）`)
  } catch (err) {
    b.buildError = err.message
    log(`触发构建失败：${err.message}`)
  }
}

/**
 * 用主 token 查一次仓库连没连上；连上了就接着写构建配置。
 *
 * 没连接时 Cloudflare 回空列表还是 403，没有文档——所以这里拿到 403 不报红，
 * 只在等待提示里带一句「也可能是主 token 缺权限」：用户还没点 Connect 就看到一个红色的
 * 权限错误，正是之前「先建构建 token 再连接」那一版踩的坑。
 */
async function detectConnection() {
  const tag = await findWorkerTag(state.token, state.accountId, state.workerName)
  let triggers
  try {
    triggers = await listTriggers(state.token, state.accountId, tag, '主 Token（第 ① 步那个）')
  } catch (err) {
    if (err.missingPermission) return { maybeMissingPermission: err.message }
    throw err
  }
  const trigger = pickProductionTrigger(triggers)
  if (!trigger) return {}
  state.builds = { tag, trigger, configured: false, error: null, buildUuid: null, build: null, buildError: null }
  log(`检测到仓库已连接 Workers Builds（生产分支 ${trigger.branch}）`)
  await setupTrigger(state.token)
  return {}
}

/** 构建进度：拿到终态之前每次轮询都查一次 */
async function refreshBuild() {
  const b = state.builds
  if (!b?.buildUuid || b.build?.outcome) return
  try {
    b.build = await getBuild(b.apiToken, state.accountId, b.buildUuid)
  } catch (err) {
    log(`查询构建状态失败：${err.message}`)
  }
}

function buildsView(extra = {}) {
  const b = state.builds
  return {
    connected: !!b,
    configured: !!b?.configured,
    branch: b?.trigger.branch ?? null,
    error: b?.error ?? null,
    buildStarted: !!b?.buildUuid,
    buildStatus: b?.build?.status ?? null,
    buildOutcome: b?.build?.outcome ?? null,
    buildError: b?.buildError ?? null,
    buildsUrl: state.accountId ? workerBuildsUrl(state.accountId, state.workerName) : null,
    ...extra,
  }
}

/**
 * 验证构建 token 能找到这个 Worker 的生产 trigger——Worker 靠它触发重建。
 * 调用前连接已经确认过，这时再遇到 403 就一定是 token 自己缺权限，可以放心点名。
 */
async function verifyBuildsToken(buildsToken) {
  let tag
  try {
    tag = await findWorkerTag(buildsToken, state.accountId, state.workerName)
  } catch (err) {
    if (err.status === 403) throw new BootstrapError('构建 Token 缺少「Workers 脚本（读取）」权限——编辑这个 token 补上（token 值不变）')
    throw err
  }
  const triggers = await listTriggers(buildsToken, state.accountId, tag, '构建 Token ')
  if (!pickProductionTrigger(triggers)) throw new BootstrapError('构建 Token 查不到这个 Worker 的构建 trigger——确认 token 的账户范围包含本账户')
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
        log('Quick Tunnel 就绪')
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
      // 之后的日志（包括 wrangler 的输出）里出现账户 ID 都打码；页面上照常显示
      mask(state.accountId)
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
      runBootstrap({
        token: state.token,
        accountId: body.accountId?.trim() || state.accountId,
        workerName,
        kvName: body.kvName?.trim() || undefined,
        d1Name: body.d1Name?.trim() || undefined,
        r2Name: body.r2Name?.trim() || undefined,
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

    if (req.method === 'GET' && url.pathname === '/api/builds-connection') {
      if (!state.provision?.ok) return json(res, 400, { error: '先完成部署' })
      let extra = {}
      if (!state.builds) {
        state.buildsBusy ??= detectConnection().finally(() => { state.buildsBusy = null })
        try {
          extra = await state.buildsBusy
        } catch (err) {
          extra = { detectError: err.message }
        }
      }
      await refreshBuild()
      json(res, 200, buildsView(extra))
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/builds-token') {
      if (!state.builds) return json(res, 400, { error: '先完成连接仓库' })
      const body = await readBody(req)
      const buildsToken = typeof body.buildsToken === 'string' ? body.buildsToken.trim() : ''
      if (!buildsToken) return json(res, 400, { error: '请先粘贴构建 Token' })
      mask(buildsToken)
      try {
        await verifyBuildsToken(buildsToken)
      } catch (err) {
        return json(res, 400, { error: err.message })
      }
      json(res, 200, { ok: true })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/complete') {
      if (!state.provision?.ok) return json(res, 400, { error: '引导尚未成功' })
      const body = await readBody(req)
      const buildsToken = typeof body.buildsToken === 'string' ? body.buildsToken.trim() : ''
      let buildsTokenWritten = false
      if (buildsToken) {
        if (!state.builds) return json(res, 400, { error: '先完成连接仓库' })
        mask(buildsToken)
        try {
          await verifyBuildsToken(buildsToken)
        } catch (err) {
          return json(res, 400, { error: err.message })
        }
        // 主 token 没把配置写进去时，用构建 token 再试一次——它有同样的权限
        if (!state.builds.configured) await setupTrigger(buildsToken)
        writeSecrets({
          repoRoot,
          token: state.token,
          accountId: state.accountId,
          workerName: state.workerName,
          secrets: { CF_BUILDS_TOKEN: buildsToken },
        })
        buildsTokenWritten = true
      }
      const triggerConfigured = !!state.builds?.configured
      const triggerError = state.builds?.error ?? null
      const finalResult = { ...state.provision.result, buildsTokenWritten, triggerConfigured }
      // run 页的 Summary 是公开的：写不带地址与标识的那一版；完整的只回给向导页面
      if (env.GITHUB_STEP_SUMMARY) {
        await writeFile(env.GITHUB_STEP_SUMMARY, renderSummary(finalResult, { publicView: true }) + '\n').catch(() => {})
      }
      state.completed = true
      json(res, 200, {
        ok: true,
        summary: renderSummary(finalResult, { redactSecrets: true }),
        triggerConfigured,
        triggerError,
        buildsTokenWritten,
      })
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
  mask(state.accountId) // 来自 workflow 输入或 secret；输入本来就公开了，secret 的得打码
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
