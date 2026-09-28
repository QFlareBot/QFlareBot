/**
 * 向导的 JSON 接口。页面（scripts/bootstrap/ui）与服务出自同一个仓库、同一次 checkout，一起改。
 *
 *   GET  /api/init                页面初始数据：默认值、预填链接、刷新后接着走的那一步
 *   POST /api/verify              { token, accountId? } 验证主 token + 权限试探
 *   GET  /api/existing?workerName= 这个名字部署过没有、上面有什么（重跑时的提示与沿用原密码）
 *   POST /api/provision           { workerName?, r2Name?, adminToken | keepAdminToken } 开始部署（异步）；失败后可以重试
 *   GET  /api/progress            部署进度：每一步的状态与用时、最近的构建输出
 *   GET  /api/builds-connection   连接检测轮询：连上即写构建配置、补跑构建；之后报构建进度
 *   POST /api/builds-token        { buildsToken } 验证构建 token（连接之后才有意义）
 *   POST /api/complete            { buildsToken? } 写入构建凭证并收尾
 *   POST /api/exit | /api/cancel  立即结束 / 终止工作流
 */

import { writeFile } from 'node:fs/promises'
import {
  ADMIN_TOKEN_MIN_LENGTH,
  adminTokenProblem,
  BootstrapError,
  BUILD_COMMAND,
  DEPLOY_COMMAND,
  listAccounts,
  probeMissingPermissions,
  renderSummary,
  runBootstrap,
  SETUP_TOKEN_URL,
  verifyToken,
  writeSecrets,
} from '../lib.mjs'
import { describeExisting } from './existing.mjs'
import { json, readBody, text } from './http.mjs'
import { log, mask } from './log.mjs'
import { createProvision, progressView, recordOutput, recordStep } from './provision.mjs'
import { resumeView } from './state.mjs'

/** 完成后留 10 分钟给用户查看、复制，也可以在页面上立即关闭 */
const CLOSE_AFTER_COMPLETE_MS = 10 * 60 * 1000

export function createRoutes({ env, state, repoRoot, builds, scheduleExit }) {
  const writeSummary = (markdown) =>
    env.GITHUB_STEP_SUMMARY ? writeFile(env.GITHUB_STEP_SUMMARY, markdown).catch(() => {}) : Promise.resolve()
  // workflow 输入里的 KV / D1 名（none = 不启用）；表单不单独问这两项
  const kvName = env.BOOT_KV_NAME?.trim() || ''
  const d1Name = env.BOOT_D1_NAME?.trim() || ''

  return {
    'GET /api/init': (req, res) =>
      json(res, 200, {
        repo: env.REPO ?? '(本地试跑)',
        defaults: { workerName: state.workerName, kvName, d1Name, r2Name: env.BOOT_R2_NAME?.trim() ?? '' },
        setupTokenUrl: SETUP_TOKEN_URL,
        // 连接仓库的表单要照填这两条：默认的 npx wrangler deploy 在这个仓库里跑不通
        buildCommand: BUILD_COMMAND,
        deployCommand: DEPLOY_COMMAND,
        adminTokenMinLength: ADMIN_TOKEN_MIN_LENGTH,
        resume: resumeView(state),
        closesAt: state.closesAt,
        now: Date.now(),
      }),

    'POST /api/verify': async (req, res) => {
      // 部署失败后可以换：最常见的失败就是 token 少了某项编辑权限
      const p = state.provision
      if (p && !(p.done && !p.ok)) return json(res, 409, { error: '部署已经开始，不能再换 Token' })
      const body = await readBody(req)
      const token = text(body.token)
      if (!token) return json(res, 400, { error: '请粘贴 API Token' })
      mask(token)
      state.token = null // 换 token 验证失败时，不能还拿着上一个去部署
      await verifyToken(token)
      const accounts = await listAccounts(token)
      let accountId = text(body.accountId) || state.accountId
      if (!accountId) {
        if (accounts.length === 0) return json(res, 400, { error: 'Token 访问不到任何账户——确认账户范围包含你的账户' })
        if (accounts.length > 1) return json(res, 400, { error: `这个 Token 能访问 ${accounts.length} 个账户，选一个部署到哪里`, accounts })
        accountId = accounts[0].id
      }
      if (accounts.length && !accounts.some((a) => a.id === accountId)) {
        return json(res, 400, { error: 'Token 访问不到指定的账户——确认账户范围包含它', accounts })
      }
      // 之后的日志（包括 wrangler 的输出）里出现账户 ID 都打码；页面上照常显示
      mask(accountId)
      const missing = await probeMissingPermissions(token, accountId)
      if (missing.length) {
        return json(res, 400, {
          error: `Token 缺少权限：${missing.map((m) => m.label).join('、')}——按预填链接重新创建一个`,
          missing: missing.map((m) => m.key),
        })
      }
      Object.assign(state, { token, accountId, accounts })
      json(res, 200, { ok: true, accountId, accountName: accounts.find((a) => a.id === accountId)?.name ?? null })
    },

    'GET /api/existing': async (req, res) => {
      if (!state.token) return json(res, 400, { error: '先完成 Token 验证' })
      const workerName = text(new URL(req.url, 'http://wizard').searchParams.get('workerName')) || state.workerName
      json(res, 200, await describeExisting({ token: state.token, accountId: state.accountId, workerName, d1Name: d1Name || workerName }))
    },

    'POST /api/provision': async (req, res) => {
      if (!state.token) return json(res, 400, { error: '先完成 Token 验证' })
      if (state.provision && !state.provision.done) return json(res, 409, { error: '部署已在进行中' })
      if (state.provision?.ok) return json(res, 409, { error: '已经部署完成' })
      const body = await readBody(req)
      // 先校验再开工：前端也拦，但不能只靠前端。沿用原密码时 runBootstrap 会先确认 Worker 上真的有
      const keepAdminToken = body.keepAdminToken === true
      const adminToken = keepAdminToken ? undefined : text(body.adminToken)
      const adminProblem = keepAdminToken ? null : adminTokenProblem(adminToken)
      if (adminProblem) return json(res, 400, { error: adminProblem })
      mask(adminToken)
      const p = createProvision()
      state.provision = p
      state.workerName = text(body.workerName) || state.workerName
      runBootstrap({
        token: state.token,
        accountId: state.accountId,
        workerName: state.workerName,
        kvName: kvName || undefined,
        d1Name: d1Name || undefined,
        r2Name: text(body.r2Name) || undefined,
        buildsToken: null, // 构建 token 在连接仓库后的收尾步骤写入
        adminToken,
        keepAdminToken,
        repoRoot,
        onStep: (name, st, detail) => recordStep(p, name, st, detail),
        onOutput: (line) => recordOutput(p, line),
      })
        .then((result) => Object.assign(p, { result, ok: true, done: true }))
        .catch((err) => {
          Object.assign(p, {
            error: err instanceof BootstrapError ? err.message : (err?.message ?? String(err)),
            hint: err instanceof BootstrapError ? (err.hint ?? null) : null,
            done: true,
          })
          log(`部署失败：${p.error}`)
        })
      json(res, 200, { started: true })
    },

    'GET /api/progress': (req, res) => json(res, 200, progressView(state.provision)),

    'GET /api/builds-connection': async (req, res) => {
      if (!state.provision?.ok) return json(res, 400, { error: '先完成部署' })
      json(res, 200, await builds.poll())
    },

    'POST /api/builds-token': async (req, res) => {
      if (!state.builds) return json(res, 400, { error: '先完成连接仓库' })
      const buildsToken = text((await readBody(req)).buildsToken)
      if (!buildsToken) return json(res, 400, { error: '请先粘贴构建 Token' })
      mask(buildsToken)
      await builds.verifyBuildsToken(buildsToken)
      json(res, 200, { ok: true })
    },

    'POST /api/complete': async (req, res) => {
      if (!state.provision?.ok) return json(res, 400, { error: '部署尚未成功' })
      if (state.completion) return json(res, 200, { ...state.completion, now: Date.now() })
      const buildsToken = text((await readBody(req)).buildsToken)
      let buildsTokenWritten = false
      if (buildsToken) {
        if (!state.builds) return json(res, 400, { error: '先完成连接仓库' })
        mask(buildsToken)
        await builds.verifyBuildsToken(buildsToken)
        // 主 token 没把配置写进去时，用构建 token 再试一次——它有同样的权限
        if (!state.builds.configured) await builds.setupTrigger(buildsToken)
        writeSecrets({ repoRoot, token: state.token, accountId: state.accountId, workerName: state.workerName, secrets: { CF_BUILDS_TOKEN: buildsToken } })
        buildsTokenWritten = true
      }
      const triggerConfigured = !!state.builds?.configured
      // 这次没给、Worker 上本来就有：沿用，不是「没配置」
      const buildsTokenKept = !buildsTokenWritten && !!state.provision.result.buildsTokenExisting
      // run 页的 Summary 是公开的：写不带地址与标识的那一版；完整信息只在向导页面上
      await writeSummary(renderSummary({ ...state.provision.result, buildsTokenWritten, triggerConfigured }, { publicView: true }) + '\n')
      state.closesAt = Date.now() + CLOSE_AFTER_COMPLETE_MS
      state.completion = { triggerConfigured, triggerError: state.builds?.error ?? null, buildsTokenWritten, buildsTokenKept, closesAt: state.closesAt }
      scheduleExit(CLOSE_AFTER_COMPLETE_MS, '向导完成后超时退出')
      json(res, 200, { ...state.completion, now: Date.now() })
    },

    'POST /api/exit': (req, res) => {
      json(res, 200, { ok: true })
      scheduleExit(1000, '收到网页端退出确认，安全关闭工作流服务')
    },

    'POST /api/cancel': async (req, res) => {
      await writeSummary(['## ⏹️ 引导已主动终止', '', '用户在网页向导中主动取消了部署工作流。', ''].join('\n'))
      json(res, 200, { ok: true })
      scheduleExit(1000, '收到网页端终止请求，停止工作流')
    },
  }
}
