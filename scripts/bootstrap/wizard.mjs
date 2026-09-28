#!/usr/bin/env node
/**
 * 网页引导：起本地 HTTP 服务 + Cloudflare Quick Tunnel，把向导页暴露出去。
 * 用户在 run 页日志里点隧道链接 → 网页上创建/粘贴 token → 建资源 → 部署 →
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
 *   wizard/server.mjs    认领与 Cookie、页面文件、接口分发
 *   wizard/routes.mjs    /api 接口
 *   wizard/builds.mjs    连接检测、写构建配置、补跑构建
 *   wizard/provision.mjs 部署进度
 *   wizard/state.mjs     内存状态与刷新续接
 *   wizard/ui.mjs        构建并读入向导页面（scripts/bootstrap/ui）
 *   wizard/tunnel.mjs    Quick Tunnel
 *
 * 本地试跑：`node scripts/bootstrap/wizard.mjs`（非 Linux 不起隧道，直接给本地地址）；
 * 只改页面时用 `pnpm --filter @qqbot/bootstrap-ui dev`，自带模拟接口。
 */

import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBuilds } from './wizard/builds.mjs'
import { log, mask } from './wizard/log.mjs'
import { createRoutes } from './wizard/routes.mjs'
import { createWizardServer } from './wizard/server.mjs'
import { createState } from './wizard/state.mjs'
import { startTunnel } from './wizard/tunnel.mjs'
import { buildUi, loadUi, uiDir } from './wizard/ui.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PORT = Number(process.env.PORT || 8787)
const IDLE_TIMEOUT_MS = 40 * 60 * 1000
const CLAIM_TIMEOUT_MS = 15 * 60 * 1000

const env = process.env
const state = createState(env)

let exitTimer = null
/** 统一的退出：后来的覆盖先前的（完成后的 10 分钟窗口里点「立即关闭」） */
function scheduleExit(delayMs, reason) {
  log(reason)
  clearTimeout(exitTimer)
  exitTimer = setTimeout(() => process.exit(0), delayMs)
}

const writeSummary = (lines) => (env.GITHUB_STEP_SUMMARY ? writeFile(env.GITHUB_STEP_SUMMARY, lines.join('\n')).catch(() => {}) : Promise.resolve())

let claimTimer = null
const session = {
  id: randomBytes(16).toString('hex'),
  cookie: null,
  onClaim() {
    clearTimeout(claimTimer)
    log('向导已被首个浏览器会话成功认领并锁定，已屏蔽其他外部访问')
  },
}

let ui = null
const server = createWizardServer({
  session,
  state,
  routes: createRoutes({ env, state, repoRoot, builds: createBuilds({ state, repoRoot }), scheduleExit }),
  getUi: () => ui,
  port: PORT,
})

async function prepareUi() {
  if (!env.WIZARD_SKIP_UI_BUILD) {
    log('构建向导页面…')
    await buildUi(repoRoot)
  }
  ui = await loadUi(path.join(uiDir(repoRoot), 'dist'))
}

server.listen(PORT, '127.0.0.1', async () => {
  mask(state.accountId) // 来自 workflow 输入或 secret；输入本来就公开了，secret 的得打码
  log(`向导服务已启动：http://127.0.0.1:${PORT}`)
  let tunnelUrl
  try {
    ;[, tunnelUrl] = await Promise.all([prepareUi(), startTunnel(PORT)])
  } catch (err) {
    log(`向导启动失败：${err.message}——改用无 UI 模式重跑（配置 CLOUDFLARE_API_TOKEN secret）`)
    process.exit(1)
  }
  const fullUrl = `${tunnelUrl}/?sid=${session.id}`
  console.log(`::notice::🚀 引导向导已就绪：${fullUrl} （尽快打开：第一个打开的浏览器会独占向导。Summary 要等这一步结束才显示，别在那里等）`)
  await writeSummary([
    '## 🚀 网页引导已就绪',
    '',
    `**👉 点这里打开向导：${fullUrl}**`,
    '',
    '> 🔒 **安全保护**：本向导链接包含专属认证凭据，首个打开链接的浏览器将独占控制权并锁定，防止未授权访问。',
    '',
    '在网页上：创建并粘贴 API token → 自定义管理密码与可选项 → 部署 Worker → 连接仓库。',
    '完成后本工作流将保持 10 分钟供查阅配置（也可在页面点击立即安全退出）。也可以在 Secret 里配置 `CLOUDFLARE_API_TOKEN` 后重跑走无 UI 模式。',
    '',
  ])

  claimTimer = setTimeout(async () => {
    if (session.cookie) return
    log('15 分钟内未被任何浏览器客户端认领，自动超时退出以节约 Actions 配额')
    await writeSummary(['## ⏱️ 向导已超时关闭', '', '在 15 分钟内未检测到用户打开向导网页，工作流已自动结束并释放 runner 资源。', ''])
    process.exit(1)
  }, CLAIM_TIMEOUT_MS)
})

setInterval(() => {
  if (Date.now() - state.lastActivity > IDLE_TIMEOUT_MS) {
    log('空闲超时，退出')
    process.exit(1)
  }
}, 60 * 1000).unref()

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
