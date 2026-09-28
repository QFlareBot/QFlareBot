/** 编排：完整的引导流程（headless.mjs 与 wizard 共用） */

import { BootstrapError, getWorkersSubdomain, listAccounts, probePermissions, verifyToken } from './cf.mjs'
import { buildAndDeploy } from './deploy.mjs'
import { buildsConnectUrl, buildsTokenUrl } from './links.mjs'
import { maskInLog } from './redact.mjs'
import { ensureD1, ensureKv, ensureR2, readInstalledPlugins } from './resources.mjs'
import { adminTokenProblem, inspectWorker, resolveBuildToken, writeSecrets } from './secrets.mjs'

/**
 * 完整引导流程。opts：
 *   token        API token（必填）
 *   accountId    可选；多账户时必填
 *   workerName   Worker/KV/D1 名（默认 qqbot）；r2Name 默认 `${workerName}-artifacts`
 *   kvName/d1Name/r2Name  覆盖各自名字；'none' = 跳过该资源（不绑定）；未填 = 默认名
 *   buildsToken  可选，提供则写为 CF_BUILDS_TOKEN secret
 *   buildToken   可选，提供则写为 BUILD_TOKEN；不提供时 Worker 上已有就沿用，没有才生成
 *   adminToken   面板登录密钥（见 adminTokenProblem）；keepAdminToken 时不填
 *   keepAdminToken  重跑时沿用 Worker 上已有的 ADMIN_TOKEN，不改密码（面板里的登录也不会失效）；
 *                Worker 上没有的话在建资源、部署之前就报错
 *   repoRoot     仓库根目录
 *   onStep       可选 (name, state: 'run'|'ok'|'warn'|'fail', detail?) => void
 *   onOutput     可选 (line) => void：构建与部署的输出（已打码），网页向导的「详细日志」用
 */
export async function runBootstrap(opts) {
  const {
    token,
    accountId: accountIdInput,
    workerName = 'qqbot',
    kvName,
    d1Name,
    r2Name,
    buildsToken,
    buildToken,
    adminToken,
    keepAdminToken = false,
    repoRoot,
    onStep = () => {},
    onOutput,
  } = opts

  const warnings = []
  const step = async (name, fn) => {
    onStep(name, 'run')
    try {
      const result = await fn()
      onStep(name, 'ok')
      return result
    } catch (err) {
      onStep(name, 'fail', err.message)
      throw err
    }
  }

  // 先于一切远端操作：密钥不合格就别建资源、别部署（沿用已有的那个要等查过 Worker 才知道有没有）
  if (!keepAdminToken) {
    const adminProblem = adminTokenProblem(adminToken)
    if (adminProblem) throw new BootstrapError(adminProblem)
  }

  await step('验证 API Token', async () => verifyToken(token))

  const accounts = await step('查询账户', () => listAccounts(token))
  if (!accounts.length) throw new BootstrapError('Token 访问不到任何账户——请确认账户范围包含你的账户')
  let accountId = accountIdInput
  if (!accountId) {
    if (accounts.length > 1) {
      // 不列账户名与 id：这句会进公开日志
      throw new BootstrapError(`Token 能访问 ${accounts.length} 个账户，需要指定用哪一个`, {
        hint: '在仓库 Secrets 里配置 CLOUDFLARE_ACCOUNT_ID（账户 ID 在 Cloudflare 后台首页右侧）后重跑；填 workflow 的 account_id 输入也行，但输入会公开显示在运行页',
      })
    }
    accountId = accounts[0].id
  }
  maskInLog(accountId)

  await step('检查 token 权限', async () => {
    const missing = await probePermissions(token, accountId)
    if (missing.length) {
      throw new BootstrapError(`Token 缺少权限：${missing.join('、')}`, {
        hint: '按 README 的权限清单重新创建 token（引导链接会预填全部权限）',
      })
    }
  })

  // 部署过没有决定三件事：走哪条部署路径、BUILD_TOKEN 沿用还是新生成、管理密钥能不能沿用
  const existing = await step('检查是否已经部署过', () => inspectWorker(token, accountId, workerName))
  if (keepAdminToken && !existing.secretNames.includes('ADMIN_TOKEN')) {
    throw new BootstrapError(`Worker ${workerName} 上还没有面板登录密钥，没法沿用`, {
      hint: '设置一个 ADMIN_TOKEN（至少 12 个字符）再部署：网页向导里直接填，无 UI 模式配成仓库的 Secret',
    })
  }

  // 资源名：未填 = 用默认名；'none' = 显式跳过该资源（D1/R2 可选跳过；KV 为核心依赖必须绑定）
  const kvTarget = kvName && kvName !== 'none' ? kvName : workerName
  const d1Target = d1Name === 'none' ? '' : (d1Name || workerName)
  const r2Target = r2Name === 'none' ? '' : (r2Name || `${workerName}-artifacts`)

  const kv = await step(`准备 KV（${kvTarget}）`, () => ensureKv(token, accountId, kvTarget))
  const d1 = d1Target
    ? await step(`准备 D1（${d1Target}）`, () => ensureD1(token, accountId, d1Target))
    : null
  let r2 = null
  if (r2Target) {
    onStep(`准备 R2（${r2Target}）`, 'run')
    try {
      r2 = await ensureR2(token, accountId, r2Target)
      onStep(`准备 R2（${r2Target}）`, 'ok')
    } catch (err) {
      onStep(`准备 R2（${r2Target}）`, 'warn', err.message)
      warnings.push(`R2 不可用（${err.message}），已降级为不绑定 R2——只有用 ctx.r2 的插件受影响。想启用：先在 Cloudflare 后台激活 R2，再重跑引导`)
    }
  }

  const bindings = {
    kvId: kv.id,
    d1Id: d1?.id,
    r2Name: r2?.name,
  }
  // wrangler 部署时会把绑定的 id 打进日志
  maskInLog(kv.id)
  maskInLog(d1?.id)

  // 子域在部署之前查：wrangler 部署完会打印 workers.dev 地址，得先打上码
  const subdomain = await step('查询 workers.dev 子域', () => getWorkersSubdomain(token, accountId))
  const defaultDomain = subdomain ? `${workerName}.${subdomain}.workers.dev` : ''
  if (!defaultDomain) {
    throw new BootstrapError('拿不到账户的 workers.dev 子域', {
      hint: '到 Cloudflare 后台 Workers & Pages 页面领取一次 workers.dev 子域后重跑',
    })
  }
  maskInLog(subdomain)

  // 已安装插件跟着一起构建，否则重跑引导会把面板里装的插件从线上抹掉（见 readInstalledPlugins）
  const installedPlugins = d1
    ? await step('读取已安装插件（D1）', () => readInstalledPlugins(token, accountId, d1.id))
    : undefined

  await step('构建并部署 Worker', () =>
    buildAndDeploy({ repoRoot, token, accountId, workerName, bindings, installedPlugins, redeploy: existing.exists, onOutput }),
  )
  // 面板、构建机拉清单走默认域名：直连 Cloudflare 边缘，零外部 DNS 依赖。
  // 回调例外——QQ 开放平台访问不到 workers.dev，必须由用户另绑自定义域名（Summary 里说明）
  const baseUrl = `https://${defaultDomain}`
  const manifestUrl = `${baseUrl}/admin/build-manifest`

  // 构建机拉清单的专用令牌不留给用户决定：以前它是可选项，不配就退回「把 ADMIN_TOKEN 当
  // MANIFEST_TOKEN 用」——等于默认把面板登录凭证发给构建环境。首次自动生成，重跑沿用（见 resolveBuildToken）
  const buildTokenPlan = resolveBuildToken({ explicit: buildToken, existingSecretNames: existing.secretNames })
  await step('写入 Worker 密钥与资源配置', () => {
    writeSecrets({
      repoRoot,
      token,
      accountId,
      workerName,
      secrets: {
        ...(keepAdminToken ? {} : { ADMIN_TOKEN: adminToken }),
        CF_ACCOUNT_ID: accountId,
        CF_WORKER_NAME: workerName,
        CF_DEFAULT_DOMAIN: defaultDomain,
        CF_KV_ID: kv.id,
        CF_D1_ID: d1?.id || '',
        CF_R2_NAME: r2?.name || '',
        // 构建机拉清单用的专用令牌（Worker 侧叫 BUILD_TOKEN，构建机侧叫 MANIFEST_TOKEN）；沿用时不写
        ...(buildTokenPlan.value ? { BUILD_TOKEN: buildTokenPlan.value } : {}),
        ...(buildsToken ? { CF_BUILDS_TOKEN: buildsToken } : {}),
      },
    })
  })

  return {
    accountId,
    workerName,
    baseUrl,
    defaultDomain,
    panelUrl: `${baseUrl}/`,
    manifestUrl,
    /** 构建机侧的 MANIFEST_TOKEN 用它，不是面板主密钥；沿用 Worker 上已有值时为 null（值读不到） */
    buildToken: buildTokenPlan.value,
    buildTokenReused: buildTokenPlan.reused,
    /** 构建 token 的预填创建链接（向导第 ⑤ 步那个按钮） */
    buildsTokenUrl: buildsTokenUrl(accountId, `${workerName}-builds`),
    /** 连接仓库的入口（向导第 ④ 步那个按钮） */
    buildsConnectUrl: buildsConnectUrl(accountId, workerName),
    resources: {
      kv: kv ? { name: kvTarget, id: kv.id, created: kv.created } : null,
      d1: d1 ? { name: d1Target, id: d1.id, created: d1.created } : null,
      r2: r2 ? { name: r2.name, created: r2.created } : null,
    },
    buildsTokenWritten: !!buildsToken,
    /** 这次没写、但 Worker 上本来就有 CF_BUILDS_TOKEN：沿用，不算「没配置」 */
    buildsTokenExisting: existing.secretNames.includes('CF_BUILDS_TOKEN'),
    /** 部署之前 Worker 就在：这是一次重跑 */
    redeployed: existing.exists,
    adminTokenKept: keepAdminToken,
    warnings,
  }
}
