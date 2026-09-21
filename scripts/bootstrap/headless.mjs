#!/usr/bin/env node
/**
 * 无 UI 引导入口：在已配置 CLOUDFLARE_API_TOKEN（GitHub secret）的工作流里直接跑完
 * 全部引导，汇总写进 GITHUB_STEP_SUMMARY。适合不想开网页向导、或重跑更新配置的场景。
 *
 * 输入（环境变量）：
 *   CLOUDFLARE_API_TOKEN     必填，GitHub secret
 *   CLOUDFLARE_BUILDS_TOKEN  可选，GitHub secret（写为 Worker 的 CF_BUILDS_TOKEN）
 *   BUILD_TOKEN              可选，GitHub secret（写为 Worker 的 BUILD_TOKEN，构建机侧叫 MANIFEST_TOKEN）；
 *                            不配的话构建机只能拿面板主密钥当清单令牌
 *   CLOUDFLARE_ACCOUNT_ID    可选，多账户时必填
 *   QQ_APPID / QQ_APP_SECRET 可选，GitHub secret；配了则部署后存进 KV
 *   BOOT_WORKER_NAME / BOOT_KV_NAME / BOOT_D1_NAME / BOOT_R2_NAME  可选资源名（none=跳过该资源）
 *   BOOT_DOMAIN              可选自定义域名
 *
 * QQ 凭证走 GitHub secret 而不是 workflow 输入：dispatch 输入会显示在 run 页面，secret 不会。
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendStepSummary, BootstrapError, renderSummary, runBootstrap, SETUP_TOKEN_URL } from './lib.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const env = process.env
if (!env.CLOUDFLARE_API_TOKEN) {
  console.error('缺少 CLOUDFLARE_API_TOKEN（应在 workflow 的 secret 里配置）')
  process.exit(1)
}

const opt = (name) => (env[name] && env[name].trim()) || undefined

const adminToken = opt('ADMIN_TOKEN')
if (!adminToken) {
  console.error('❌ 缺少 ADMIN_TOKEN！')
  console.error('无 UI 引导模式必须显式提供管理密钥（ADMIN_TOKEN）。')
  console.error('为防止敏感信息泄露，GitHub Actions 会对公共日志与 Step Summary 进行安全脱敏。若由系统随机生成您将无法获知登录密码。')
  console.error('请在仓库设置（Settings → Secrets and variables → Actions）中配置 Secret `ADMIN_TOKEN` 后重试；或者清空 CLOUDFLARE_API_TOKEN 使用网页向导模式（可在向导中直接输入或查看密码）。')
  process.exit(1)
}

if (adminToken) console.log(`::add-mask::${adminToken}`)
if (env.QQ_APP_SECRET) console.log(`::add-mask::${env.QQ_APP_SECRET}`)
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
    domain: opt('BOOT_DOMAIN'),
    qq: env.QQ_APPID && env.QQ_APP_SECRET ? { appId: env.QQ_APPID, secret: env.QQ_APP_SECRET } : undefined,
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
  const summary = renderSummary(result, { redactSecrets: isCi })
  appendStepSummary(summary)

  if (isCi) {
    console.log('\n✅ 引导部署完成！完整面板地址与配置参数已写入本页 GitHub Step Summary。')
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
