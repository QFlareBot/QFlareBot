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

const env = process.env
const state = {
  token: null,
  accountId: env.BOOT_ACCOUNT_ID?.trim() || null,
  accounts: [],
  workerName: env.BOOT_WORKER_NAME?.trim() || 'qqbot',
  provision: null, // { lines: [], done, ok, error, result }
  completed: false,
  lastActivity: Date.now(),
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
    const deadline = Date.now() + 90 * 1000
    const onData = (chunk) => {
      const text = String(chunk)
      const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(text)
      if (match) {
        child.stdout.off('data', onData)
        child.stderr.off('data', onData)
        log(`Quick Tunnel 就绪：${match[0]}`)
        resolveTunnel(match[0])
      } else if (Date.now() > deadline) {
        rejectTunnel(new Error('等待 trycloudflare 地址超时'))
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => rejectTunnel(new Error(`cloudflared 提前退出（${code}）`)))
  })
}

// ── 服务 ─────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  state.lastActivity = Date.now()
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)

  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = await readFile(path.join(repoRoot, 'scripts', 'bootstrap', 'page.html'), 'utf8')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
      return
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
      json(res, 200, p ? { lines: p.lines, done: p.done, ok: p.ok, error: p.error, hint: p.hint ?? null } : { lines: [], done: false, ok: false })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/builds-status') {
      if (!state.token || !state.accountId) return json(res, 400, { error: '先完成引导' })
      try {
        const scripts = await cfFetch(state.token, `/accounts/${state.accountId}/workers/scripts`)
        const me = (Array.isArray(scripts) ? scripts : scripts?.items ?? []).find((s) => s?.id === state.workerName)
        if (!me?.tag) return json(res, 200, { connected: false })
        const triggers = await cfFetch(state.token, `/accounts/${state.accountId}/builds/workers/${me.tag}/triggers`)
        const items = Array.isArray(triggers) ? triggers : triggers?.items ?? []
        json(res, 200, { connected: items.length > 0 })
      } catch (err) {
        json(res, 200, { connected: false, error: err.message })
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
        writeSecrets({ repoRoot, token: state.token, secrets: { CF_BUILDS_TOKEN: buildsToken } })
        buildsTokenWritten = true
      }
      const summary = renderSummary({
        ...state.provision.result,
        buildsTokenWritten,
      })
      if (env.GITHUB_STEP_SUMMARY) {
        await writeFile(env.GITHUB_STEP_SUMMARY, summary + '\n').catch(() => {})
      }
      state.completed = true
      json(res, 200, { ok: true, summary })
      setTimeout(() => process.exit(0), 3000) // 给页面留出收到响应的时间
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
    const notice = `::notice::🚀 引导向导已就绪：${tunnelUrl} （请在 run 页 Summary 里点开，跟着网页完成部署）`
    console.log(notice)
    if (env.GITHUB_STEP_SUMMARY) {
      await writeFile(
        env.GITHUB_STEP_SUMMARY,
        [
          '## 🚀 网页引导已就绪',
          '',
          `**👉 点这里打开向导：${tunnelUrl}**`,
          '',
          '在网页上：创建并粘贴 API token → 填名称与可选项 → 看进度 → 连接仓库 → 创建构建 token。',
          '完成后本工作流自动结束；链接 40 分钟内有效。也可以在 secret 里配置 `CLOUDFLARE_API_TOKEN` 后重跑本工作流走无 UI 模式。',
          '',
        ].join('\n'),
      )
    }
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
