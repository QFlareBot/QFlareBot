#!/usr/bin/env node
/**
 * 无 UI 引导入口：在已配置 CLOUDFLARE_API_TOKEN（GitHub secret）的工作流里直接跑完
 * 全部引导，汇总写进 GITHUB_STEP_SUMMARY。适合不想开网页向导、或重跑更新配置的场景。
 *
 * 输入（环境变量）：
 *   CLOUDFLARE_API_TOKEN     必填，GitHub secret
 *   ADMIN_TOKEN              必填，GitHub secret：面板登录密码，自己定（至少 12 个字符），引导不代为生成
 *   CLOUDFLARE_BUILDS_TOKEN  可选，GitHub secret（写为 Worker 的 CF_BUILDS_TOKEN）
 *   BUILD_TOKEN              可选，GitHub secret（写为 Worker 的 BUILD_TOKEN，构建机侧叫 MANIFEST_TOKEN）；
 *                            不配时首次自动生成，重跑沿用 Worker 上已有的值（不轮换）
 *   CLOUDFLARE_ACCOUNT_ID    可选，多账户时必填（workflow 输入或同名 secret）
 *   BOOT_WORKER_NAME / BOOT_KV_NAME / BOOT_D1_NAME / BOOT_R2_NAME  可选资源名（none=跳过该资源）
 *
 * QQ 机器人不在这里配：部署完到面板「设置」里扫码创建或填入凭证。
 * 公开仓库的日志与 Summary 谁都能看：Summary 用 publicView 渲染，不带地址与标识。
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { adminTokenProblem, appendStepSummary, BootstrapError, renderSummary, runBootstrap, SETUP_TOKEN_URL } from './lib.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const env = process.env
if (!env.CLOUDFLARE_API_TOKEN) {
  console.error('缺少 CLOUDFLARE_API_TOKEN（应在 workflow 的 secret 里配置）')
  process.exit(1)
}

const opt = (name) => (env[name] && env[name].trim()) || undefined

const adminToken = opt('ADMIN_TOKEN')
const adminProblem = adminTokenProblem(adminToken)
if (adminProblem) {
  console.error(`❌ ${adminProblem}`)
  console.error('请在仓库 Settings → Secrets and variables → Actions 里配置 Secret `ADMIN_TOKEN` 后重试。')
  process.exit(1)
}

console.log(`::add-mask::${adminToken}`)
if (env.CLOUDFLARE_BUILDS_TOKEN) console.log(`::add-mask::${env.CLOUDFLARE_BUILDS_TOKEN}`)
if (env.BUILD_TOKEN) console.log(`::add-mask::${env.BUILD_TOKEN}`)

try {
  const result = await runBootstrap({
    token: env.CLOUDFLARE_API_TOKEN,
    accountId: opt('CLOUDFLARE_ACCOUNT_ID'),
    workerName: opt('BOOT_WORKER_NAME') ?? 'qqbot',
    kvName: opt('BOOT_KV_NAME'),
    d1Name: opt('BOOT_D1_NAME'),
    r2Name: opt('BOOT_R2_NAME'),
    buildsToken: opt('CLOUDFLARE_BUILDS_TOKEN'),
    buildToken: opt('BUILD_TOKEN'),
    adminToken,
    repoRoot,
    onStep: (name, state, detail) => {
      const mark = state === 'ok' ? '✅' : state === 'run' ? '⏳' : state === 'warn' ? '⚠️ ' : '❌'
      console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`)
    },
  })

  const isCi = !!process.env.GITHUB_STEP_SUMMARY
  appendStepSummary(renderSummary(result, { publicView: isCi }))

  if (isCi) {
    console.log('\n✅ 引导部署完成！后续步骤见本页 Summary（为了不公开你的地址，面板地址请到 Cloudflare 后台查看）。')
    console.log('管理密钥 ADMIN_TOKEN：已使用您预设的 Secret 配置，请使用该密钥登录管理后台。')
  } else {
    console.log('\n' + renderSummary(result, { redactSecrets: false }))
  }
  console.log(`\n主 Token 预填创建链接（供未建 token 的后来者参考）：\n${SETUP_TOKEN_URL}`)
} catch (err) {
  const message = err instanceof BootstrapError ? err.message : (err?.message ?? String(err))
  console.error(`\n❌ 引导失败：${message}`)
  if (err instanceof BootstrapError && err.hint) console.error(`提示：${err.hint}`)
  process.exit(1)
}
