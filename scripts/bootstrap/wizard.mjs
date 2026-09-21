#!/usr/bin/env node
/**
 * 网页引导：起本地 HTTP 服务 + Cloudflare Quick Tunnel，把向导页暴露出去。
 * 用户在 run 页 Summary 里点隧道链接 → 网页上创建/粘贴 token → 建资源 → 部署 →
 * 连接仓库 → 创建构建 token，全程跟着页面走。
 *
 * 安全边界：
 * - token 只在本进程内存里，收到即输出 ::add-mask::（Actions 日志自动打码）
 * - Quick Tunnel 是随机不可猜 URL + HTTPS，但本质是临时公开入口——向导结束后即关闭
 * - 进程在完成或 40 分钟无活动后退出
 *
 * API（全部 JSON）：
 *   GET  /api/init                   页面初始数据（默认值、token 预填链接）
 *   POST /api/verify                 { token, accountId? } 验证主 token + 权限试探
 *   POST /api/provision              表单提交，启动引导（异步）
 *   GET  /api/progress               进度轮询
 *   GET  /api/builds-status          仓库是否已连接 Workers Builds
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
  BootstrapError,
  cfFetch,
  listAccounts,
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

/** 解析 Workers Builds 权限组的 dash key（用于构建 token 预填链接）；失败返回 null */
async function resolveBuildsPermissionKey(token, accountId) {
  const endpoints = [`/accounts/${accountId}/rbac/groups`, `/accounts/${accountId}/tokens/permission_groups`]
  for (const endpoint of endpoints) {
    try {
      const groups = await cfFetch(token, endpoint)
      const items = Array.isArray(groups) ? groups : (groups?.items ?? [])
      const hit = items.find((g) => typeof g?.key === 'string' && /workers\s*builds/i.test(g?.name ?? g?.label ?? ''))
      if (hit) return hit.key
    } catch {
      // 换下一个端点
    }
  }
  return null
}

function buildsTokenUrl(accountId, key, tokenName) {
  const groups = [{ key, type: 'edit' }, { key: 'workers_scripts', type: 'read' }]
  const params = new URLSearchParams()
  params.set('permissionGroupKeys', JSON.stringify(groups))
  params.set('accountId', accountId)
  params.set('zoneId', 'all')
  params.set('name', tokenName)
  return `https://dash.cloudflare.com/profile/api-tokens?${params.toString()}`
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
          domain: env.BOOT_DOMAIN ?? '',
          accountId: state.accountId ?? '',
        },
        setupTokenUrl: SETUP_TOKEN_URL,
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

    if (req.method === 'POST' && url.pathname === '/api/provision') {
      if (!state.token) return json(res, 400, { error: '先完成 token 验证' })
      if (state.provision && !state.provision.done) return json(res, 409, { error: '引导已在进行中' })
      const body = await readBody(req)
      const lines = []
      const provision = { lines, done: false, ok: false, error: null, result: null }
      state.provision = provision
      const workerName = (body.workerName || state.workerName).trim() || 'qqbot'
      state.workerName = workerName
      const adminToken = (typeof body.adminToken === 'string' && body.adminToken.trim()) || undefined
      if (adminToken) mask(adminToken)
      if (body.qqSecret) mask(body.qqSecret)
      runBootstrap({
        token: state.token,
        accountId: body.accountId?.trim() || state.accountId,
        workerName,
        kvName: body.kvName?.trim() || undefined,
        d1Name: body.d1Name?.trim() || undefined,
        r2Name: body.r2Name?.trim() || undefined,
        domain: body.domain?.trim() || undefined,
        qq: body.qqAppId && body.qqSecret ? { appId: body.qqAppId.trim(), secret: body.qqSecret.trim() } : undefined,
        buildsToken: null, // 构建 token 在连接仓库后的收尾步骤写入
        adminToken: adminToken || undefined,
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
        const triggers = await cfFetch(buildsToken, `/accounts/${state.accountId}/builds/workers/${me.tag}/triggers`)
        const items = Array.isArray(triggers) ? triggers : triggers?.items ?? []
        json(res, 200, { ok: true, connected: items.length > 0, count: items.length })
      } catch (err) {
        json(res, 200, { ok: false, connected: false, error: err.message })
      }
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/builds-token-url') {
      // 现场解析 Builds 权限组 key，生成预填链接；解析不到给 null（页面退回清单引导）
      if (!state.token || !state.accountId) return json(res, 400, { error: '先完成引导' })
      const key = await resolveBuildsPermissionKey(state.token, state.accountId)
      json(res, 200, {
        url: key ? buildsTokenUrl(state.accountId, key, `${state.workerName}-builds`) : null,
        fallback: !key,
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/complete') {
      if (!state.provision?.ok) return json(res, 400, { error: '引导尚未成功' })
      const body = await readBody(req)
      let buildsTokenWritten = false
      if (body.buildsToken && typeof body.buildsToken === 'string') {
        const buildsToken = body.buildsToken.trim()
        mask(buildsToken)
        // 用构建 token 实际打一次 trigger 列表，验证它真能触发重建
        const verify = async () => {
          const scripts = await cfFetch(buildsToken, `/accounts/${state.accountId}/workers/scripts`)
          const me = (Array.isArray(scripts) ? scripts : scripts?.items ?? []).find((s) => s?.id === state.workerName)
          if (!me?.tag) throw new Error(`找不到脚本 ${state.workerName}`)
          const triggers = await cfFetch(buildsToken, `/accounts/${state.accountId}/builds/workers/${me.tag}/triggers`)
          const items = Array.isArray(triggers) ? triggers : triggers?.items ?? []
          if (!items.length) throw new Error('仓库尚未连接 Workers Builds（查不到 trigger）——先完成连接仓库一步')
        }
        await verify()
        writeSecrets({ repoRoot, token: state.token, accountId: state.accountId, workerName: state.workerName, secrets: { CF_BUILDS_TOKEN: buildsToken } })
        buildsTokenWritten = true
      }
      const summary = renderSummary({
        ...state.provision.result,
        buildsTokenWritten,
      }, { redactSecrets: true })
      if (env.GITHUB_STEP_SUMMARY) {
        await writeFile(env.GITHUB_STEP_SUMMARY, summary + '\n').catch(() => {})
      }
      state.completed = true
      json(res, 200, { ok: true, summary })
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
