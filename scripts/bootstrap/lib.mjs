/**
 * 引导部署核心库（headless.mjs 与 wizard.mjs 共用）。
 *
 * 职责：校验 API token → 推导账户 → 幂等创建/复用 KV / D1 / R2 → 构建 + 部署 Worker
 * （环境变量动态注入基础设施绑定，零 Git 污染）→ wrangler secret bulk 写入运行时密钥 →
 * 可选向 QQ 验证凭据存入 KV。
 *
 * 设计约束：
 * - 幂等：资源按名字查到即复用；重跑只补缺，零 Git 污染
 * - token 只经环境变量/内存传递，绝不打印、绝不落盘
 * - R2 创建失败（未激活/无权限）降级为去掉 R2 绑定而不是整体失败
 */

import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const CF_API = 'https://api.cloudflare.com/client/v4'

export class BootstrapError extends Error {
  constructor(message, { hint, status, errors } = {}) {
    super(message)
    this.name = 'BootstrapError'
    this.hint = hint
    this.status = status
    this.errors = errors
  }
}

/** Cloudflare REST 请求：统一信封解析，失败抛带 API 错误详情的 BootstrapError */
export async function cfFetch(token, apiPath, { method = 'GET', body } = {}) {
  let res
  try {
    res = await fetch(`${CF_API}${apiPath}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  } catch (err) {
    throw new BootstrapError(`Cloudflare API 网络错误：${err.message}`, { hint: '检查 runner 网络或稍后重试' })
  }
  let envelope
  try {
    envelope = await res.json()
  } catch {
    throw new BootstrapError(`Cloudflare API 返回非 JSON（HTTP ${res.status}）`)
  }
  if (!res.ok || envelope.success === false) {
    const detail = (envelope.errors ?? []).map((e) => `[${e.code}] ${e.message}`).join('; ') || `HTTP ${res.status}`
    throw new BootstrapError(`Cloudflare API ${method} ${apiPath} 失败：${detail}`, {
      status: res.status,
      errors: envelope.errors ?? [],
    })
  }
  return envelope.result
}

/** 验证 token 本身有效且激活 */
export async function verifyToken(token) {
  const result = await cfFetch(token, '/user/tokens/verify', { method: 'POST' })
  if (result?.status !== 'active') {
    throw new BootstrapError(`Token 状态不是 active：${result?.status ?? '未知'}`)
  }
  return { id: result.id }
}

/** 列出 token 可访问的账户；多账户时由调用方决定怎么选 */
export async function listAccounts(token) {
  const accounts = []
  let page = 1
  for (;;) {
    const result = await cfFetch(token, `/accounts?per_page=50&page=${page}`)
    accounts.push(...(result ?? []))
    if (!result?.length || result.length < 50) break
    page++
  }
  return accounts.map((a) => ({ id: a.id, name: a.name }))
}

/**
 * 权限试探：逐个 GET 只读端点，401/403 即缺权限。
 * 返回 missing 列表（空数组 = 通过）。
 *
 * **只能证明「读」权限**：GET 通过不代表 Edit 存在，缺 Edit 要等真正部署时才报 403。
 * 所以这个结果不是「权限齐备」的保证——请按 README 的权限清单创建 token（引导链接已预填全部权限）。
 * account_settings 的读权限由 listAccounts 能否拿到该账户隐式验证，这里不再单独试探。
 */
export async function probePermissions(token, accountId) {
  const probes = [
    { label: 'Workers Scripts（读）', path: `/accounts/${accountId}/workers/scripts`, r2: false },
    { label: 'KV Storage（读）', path: `/accounts/${accountId}/storage/kv/namespaces?per_page=1`, r2: false },
    { label: 'D1（读）', path: `/accounts/${accountId}/d1/database?per_page=1`, r2: false },
    // R2 未激活的账号这条必 4xx，不算缺权限——留给创建阶段降级
    { label: 'R2（读）', path: `/accounts/${accountId}/r2/buckets?per_page=1`, r2: true },
  ]
  const missing = []
  for (const probe of probes) {
    try {
      await cfFetch(token, probe.path)
    } catch (err) {
      if (probe.r2) continue
      missing.push(probe.label)
    }
  }
  return missing
}

/** KV：按 title 查找，缺则创建；返回 { id, created } */
export async function ensureKv(token, accountId, title) {
  let page = 1
  for (;;) {
    const list = await cfFetch(token, `/accounts/${accountId}/storage/kv/namespaces?per_page=100&page=${page}`)
    const hit = list.find((n) => n.title === title)
    if (hit) return { id: hit.id, created: false }
    if (!list?.length || list.length < 100) break
    page++
  }
  const created = await cfFetch(token, `/accounts/${accountId}/storage/kv/namespaces`, { method: 'POST', body: { title } })
  return { id: created.id, created: true }
}

/** D1：按名称查找，缺则创建；返回 { id, created } */
export async function ensureD1(token, accountId, name) {
  let page = 1
  for (;;) {
    const list = await cfFetch(token, `/accounts/${accountId}/d1/database?per_page=100&page=${page}`)
    const hit = list.find((d) => d.name === name)
    if (hit) return { id: hit.uuid, created: false }
    if (!list?.length || list.length < 100) break
    page++
  }
  const created = await cfFetch(token, `/accounts/${accountId}/d1/database`, { method: 'POST', body: { name } })
  return { id: created.uuid, created: true }
}

/** R2：按名称查找，缺则创建。未激活/无权限时抛 BootstrapError（调用方降级） */
export async function ensureR2(token, accountId, name) {
  let page = 1
  for (;;) {
    const list = await cfFetch(token, `/accounts/${accountId}/r2/buckets?per_page=100&page=${page}`)
    const buckets = list?.buckets ?? list ?? []
    const hit = buckets.find((b) => b.name === name)
    if (hit) return { name: hit.name, created: false }
    if (!buckets?.length || buckets.length < 100) break
    page++
  }
  await cfFetch(token, `/accounts/${accountId}/r2/buckets`, { method: 'POST', body: { name } })
  return { name, created: true }
}

/** workers.dev 子域（拼面板/回调地址用） */
export async function getWorkersSubdomain(token, accountId) {
  const result = await cfFetch(token, `/accounts/${accountId}/workers/subdomain`)
  return result?.subdomain ?? null
}

// ── 命令执行 ─────────────────────────────────────────────────────────────

function runAsync(cmd, args, { cwd, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: 'inherit',
      env: { ...process.env, ...env },
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) reject(new BootstrapError(`命令失败（退出码 ${code}）：${cmd} ${args.join(' ')}`))
      else resolve()
    })
  })
}

export async function buildAndDeploy({ repoRoot, token, accountId, workerName, bindings = {} }) {
  const env = {
    CLOUDFLARE_API_TOKEN: token,
    CLOUDFLARE_ACCOUNT_ID: accountId,
    ...(workerName ? { CF_WORKER_NAME: workerName } : {}),
    ...(bindings.kvId ? { CF_KV_ID: bindings.kvId } : {}),
    ...(bindings.d1Id ? { CF_D1_ID: bindings.d1Id } : {}),
    ...(bindings.r2Name ? { CF_R2_NAME: bindings.r2Name } : {}),
    ...(bindings.domain ? { CF_CUSTOM_DOMAIN: bindings.domain } : {}),
    INITIAL_BOOTSTRAP: 'true',
  }
  await runAsync('pnpm', ['install', '--frozen-lockfile'], { cwd: repoRoot })
  await runAsync('pnpm', ['--filter', '@qqbot/seed', 'run', 'deploy:manifest'], { cwd: repoRoot, env })
}

/** 部署后写 Worker secrets（wrangler secret bulk，stdin 传 JSON）；token 仅用于 wrangler 鉴权 */
export function writeSecrets({ repoRoot, secrets, token, accountId, workerName }) {
  const entries = Object.entries(secrets).filter(([, v]) => typeof v === 'string' && v.length > 0)
  if (!entries.length) return
  const payload = JSON.stringify(Object.fromEntries(entries))
  const seedDir = path.join(repoRoot, 'apps', 'seed')
  const args = ['exec', 'wrangler', 'secret', 'bulk']
  if (workerName) args.push('--name', workerName)
  const r = spawnSync('pnpm', args, {
    cwd: seedDir,
    input: payload,
    stdio: ['pipe', 'inherit', 'inherit'],
    env: {
      ...process.env,
      CLOUDFLARE_API_TOKEN: token,
      ...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}),
    },
  })
  if (r.status !== 0) throw new BootstrapError('wrangler secret bulk 失败')
}

/** QQ 凭证存进 KV：与管理面板同一条路径，保存前运行时会先向 QQ 验证 */
export async function putBotConfig({ baseUrl, adminToken, appId, secret }) {
  let res
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, '')}/admin/bot`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ appId, secret }),
    })
  } catch (err) {
    throw new BootstrapError(`写入 QQ 凭证时网络错误：${err.message}`)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new BootstrapError(`保存 QQ 凭证失败：${data.error ?? `HTTP ${res.status}`}`)
  return true
}

// ── 汇总输出 ─────────────────────────────────────────────────────────────

/** 主 token 的预填创建链接（权限组 key 已实测有效） */
export const SETUP_TOKEN_URL =
  'https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_kv_storage%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22d1%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_r2%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22account_settings%22%2C%22type%22%3A%22read%22%7D%5D&accountId=*&zoneId=all&name=qqbot-setup'

/**
 * 构建机上的构建与部署命令。向导会经 Builds API 直接写进 trigger；
 * headless 模式连接仓库时 trigger 还不存在，只能打进 Summary 让人照抄。
 *
 * 权威定义在 `packages/projector/src/builds.ts`（Worker 侧自动写 trigger 要用）。
 * 这里是副本——引导是裸 Node 脚本，跑在 `pnpm build` 之前，import 不到构建产物。
 * 两边由 `packages/projector/src/builds.test.ts` 断言一致，改一处 CI 会红。
 */
export const BUILD_COMMAND = 'pnpm build && pnpm --filter @qqbot/seed run manifest:prepare'
export const DEPLOY_COMMAND = 'pnpm --filter @qqbot/seed run manifest:deploy'

/**
 * 构建 token 的预填创建链接。
 *
 * `permissionGroupKeys` 用的是 dash 自己那套短 key（跟 SETUP_TOKEN_URL 同一套），
 * **不是** `/accounts/{id}/tokens/permission_groups` 返回的 UUID。早先这里会去查那个端点
 * 再取 `key` 字段，两头都不成立：引导 token 没有 API Tokens Read 权限（必然 403），
 * 而那个端点的返回里也根本没有 `key` 字段——于是解析永远失败，页面永远退回
 * 「请手动勾选权限」，这个按钮从来没真正工作过。写死即可。
 */
export function buildsTokenUrl(accountId, tokenName) {
  const groups = [
    { key: 'workers_builds', type: 'edit' },
    { key: 'workers_scripts', type: 'read' },
  ]
  const params = new URLSearchParams()
  params.set('permissionGroupKeys', JSON.stringify(groups))
  params.set('accountId', accountId)
  params.set('zoneId', 'all')
  params.set('name', tokenName)
  return `https://dash.cloudflare.com/profile/api-tokens?${params.toString()}`
}

/** Workers Builds 后台的连接页（worker 详情 → Builds） */
export function buildsConnectUrl(accountId, workerName) {
  return `https://dash.cloudflare.com/${accountId}/workers/services/view/${encodeURIComponent(workerName)}/production/builds`
}

/** Worker 的 Domains & Routes / Triggers 设置页 */
export function workerDomainsUrl(accountId, workerName) {
  return `https://dash.cloudflare.com/${accountId}/workers/services/view/${encodeURIComponent(workerName)}/production/settings/triggers`
}

/** 把引导结果渲染成 Markdown 汇总（GITHUB_STEP_SUMMARY / 向导完成页共用） */
export function renderSummary(result, { redactSecrets = false } = {}) {
  const {
    baseUrl,
    defaultDomain,
    domain,
    panelUrl,
    webhookUrl,
    manifestUrl,
    adminToken,
    buildToken,
    resources,
    buildsTokenWritten,
    triggerConfigured,
    qqSaved,
    warnings,
    accountId,
    workerName,
  } = result
  const lines = []
  lines.push('## ✅ 引导部署完成')
  lines.push('')
  lines.push('| 项目 | 值 |')
  lines.push('| --- | --- |')
  lines.push(`| 管理面板 | ${panelUrl} |`)
  lines.push(`| 回调地址（填到 QQ 开放平台） | \`${webhookUrl}\` |`)
  lines.push(`| 构建机拉清单地址（MANIFEST_URL） | \`${manifestUrl}\` |`)
  if (defaultDomain && defaultDomain !== domain) {
    lines.push(`| 默认域名（构建直连） | \`${defaultDomain}\` |`)
  }
  if (resources.kv) lines.push(`| KV | ${resources.kv.name}${resources.kv.created ? '（新建）' : '（复用已有）'} |`)
  if (resources.d1) lines.push(`| D1 | ${resources.d1.name}${resources.d1.created ? '（新建）' : '（复用已有）'} |`)
  if (resources.r2) lines.push(`| R2 | ${resources.r2.name}${resources.r2.created ? '（新建）' : '（复用已有）'} |`)
  lines.push('')
  lines.push('<details><summary><b>ADMIN_TOKEN</b>（面板登录密钥）</summary>')
  lines.push('')
  if (redactSecrets) {
    lines.push('⚠️ **为防止公开仓库泄露密钥，ADMIN_TOKEN 未明文写入本页公共 Step Summary。**')
    lines.push('')
    lines.push('- **无 UI 部署**：已应用您在 GitHub Secrets 中指定的 `ADMIN_TOKEN`；')
    lines.push('- **网页向导部署**：已在向导网页中设置/展示；')
    lines.push('- 若后续遗忘，可在 Cloudflare 控制台（Worker -> Settings -> Variables and Secrets）中重置，或使用 `wrangler secret put ADMIN_TOKEN` 重新设置。')
  } else {
    lines.push('```')
    lines.push(adminToken)
    lines.push('```')
  }
  lines.push('')
  lines.push('</details>')
  lines.push('')
  lines.push('### 下一步')
  lines.push('')
  if (triggerConfigured) {
    lines.push(
      `1. **构建配置已自动写入**：Build command、Deploy command、\`MANIFEST_URL\`、\`MANIFEST_TOKEN\` 都已经通过 Builds API ` +
        `写进了这个 Worker 的构建 trigger，[后台](${buildsConnectUrl(accountId, workerName)})一个格子都不用填。到面板装一个插件即可验证重建链路。`,
    )
  } else {
    lines.push(
      `1. **连接仓库**（装/卸插件触发重建的前置）：打开 [Workers Builds 设置页](${buildsConnectUrl(accountId, workerName)}) → Connect，` +
        '选择本 fork 仓库，分支选默认分支，然后照抄下面四项。' +
        '（网页向导模式会在连接完成后自动写入这四项，不必手抄；这里是无 UI 模式的兜底——' +
        '工作流跑的时候仓库还没连接，trigger 不存在，写不了。）',
    )
    lines.push('')
    lines.push('   ```')
    lines.push('   # Build command')
    lines.push(`   ${BUILD_COMMAND}`)
    lines.push('   # Deploy command')
    lines.push(`   ${DEPLOY_COMMAND}`)
    lines.push('   # 环境变量（Settings → Builds → Environment variables）')
    lines.push(`   MANIFEST_URL=${manifestUrl}`)
    // Worker 侧叫 BUILD_TOKEN、构建机侧叫 MANIFEST_TOKEN，是同一个值——名字不一致最容易配错
    lines.push(`   MANIFEST_TOKEN=${redactSecrets ? '<引导自动生成的 BUILD_TOKEN，见下>' : buildToken}`)
    lines.push('   ```')
    if (redactSecrets) {
      lines.push('')
      lines.push(
        '   🔑 `BUILD_TOKEN` 由引导自动生成并写入 Worker，为避免公开日志泄露没有打印在这里。' +
          '取值：Cloudflare 控制台看不到 secret 明文，直接 `wrangler secret put BUILD_TOKEN` 重设一个随机长字符串，' +
          '再把构建机侧的 `MANIFEST_TOKEN` 填成同一个值即可。',
      )
    }
  }
  if (buildsTokenWritten) {
    lines.push('')
    lines.push('   构建凭证 `CF_BUILDS_TOKEN` 已写入 Worker，装插件时自动触发重建。')
  } else {
    lines.push('')
    lines.push('   **尚未配置 `CF_BUILDS_TOKEN`**（Worker 触发重建用）：创建一个 user token（权限：Workers Builds Configuration Edit + Workers Scripts Read，账户范围限本账户），`wrangler secret put CF_BUILDS_TOKEN` 写入，或重跑引导时带上。配置后到面板装一个插件即可验证重建链路。')
  }
  lines.push('')
  if (!domain) {
    lines.push(`2. **绑定自定义域名**（国内 QQ 开放平台 Webhook 刚需）：`)
    lines.push(`   由于国内网络无法稳定直连 \`*.workers.dev\`，请打开 [Cloudflare 域名设置页](${workerDomainsUrl(accountId, workerName)})，在 **Custom Domains** 中添加你的二级域名（如 \`bot.yourdomain.com\`）。`)
    lines.push(`   绑定后，QQ 开放平台的回调地址即为：\`https://你的域名/webhook\`。`)
    lines.push('')
    lines.push(`3. **QQ 开放平台**：在 [q.qq.com](https://q.qq.com) 机器人管理里把回调地址填好${qqSaved ? '。QQ 凭证已在引导时保存进 KV。' : '，再到管理面板 → 设置里保存 AppID/AppSecret（存 KV）。'}`)
  } else {
    lines.push(`2. **QQ 开放平台**：在 [q.qq.com](https://q.qq.com) 机器人管理里把回调地址填成 \`${webhookUrl}\`${qqSaved ? '。QQ 凭证已在引导时保存进 KV。' : '，再到管理面板 → 设置里保存 AppID/AppSecret（存 KV）。'}`)
  }
  lines.push('')
  if (warnings.length) {
    lines.push('### ⚠️ 提醒')
    lines.push('')
    for (const w of warnings) lines.push(`- ${w}`)
    lines.push('')
  }
  lines.push('> 幂等：本工作流可随时重跑。重跑会复用同名资源；重跑时填了新的自定义域名会切换域名。')
  lines.push('')
  return lines.join('\n')
}

/** 把 Markdown 追加到 GITHUB_STEP_SUMMARY（存在时） */
export function appendStepSummary(markdown) {
  if (!process.env.GITHUB_STEP_SUMMARY) return
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + '\n')
}

// ── 编排 ─────────────────────────────────────────────────────────────────

/**
 * 完整引导流程。opts：
 *   token        API token（必填）
 *   accountId    可选；多账户时必填
 *   workerName   Worker/KV/D1 名（默认 qqbot）；r2Name 默认 `${workerName}-artifacts`
 *   kvName/d1Name/r2Name  覆盖各自名字；'none' = 跳过该资源（不绑定）；未填 = 默认名
 *   domain       可选自定义域名
 *   qq           可选 { appId, secret }，提供则部署后存进 KV
 *   buildsToken  可选，提供则写为 CF_BUILDS_TOKEN secret
 *   repoRoot     仓库根目录
 *   onStep       可选 (name, state: 'run'|'ok'|'warn'|'fail', detail?) => void
 */
export async function runBootstrap(opts) {
  const {
    token,
    accountId: accountIdInput,
    workerName = 'qqbot',
    kvName,
    d1Name,
    r2Name,
    domain,
    qq,
    buildsToken,
    buildToken,
    adminToken: customAdminToken,
    repoRoot,
    onStep = () => {},
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

  await step('验证 API Token', async () => verifyToken(token))

  const accounts = await step('查询账户', () => listAccounts(token))
  if (!accounts.length) throw new BootstrapError('Token 访问不到任何账户——请确认账户范围包含你的账户')
  let accountId = accountIdInput
  if (!accountId) {
    if (accounts.length > 1) {
      throw new BootstrapError(
        `Token 能访问 ${accounts.length} 个账户（${accounts.map((a) => `${a.name}(${a.id})`).join('、')}），请在输入里指定 accountId 后重跑`,
      )
    }
    accountId = accounts[0].id
  }

  await step('检查 token 权限', async () => {
    const missing = await probePermissions(token, accountId)
    if (missing.length) {
      throw new BootstrapError(`Token 缺少权限：${missing.join('、')}`, {
        hint: '按 README 的权限清单重新创建 token（引导链接会预填全部权限）',
      })
    }
  })

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
    domain,
  }

  await step('构建并部署 Worker', () => buildAndDeploy({ repoRoot, token, accountId, workerName, bindings }))

  const subdomain = await step('查询 workers.dev 子域', () => getWorkersSubdomain(token, accountId))
  const defaultDomain = subdomain ? `${workerName}.${subdomain}.workers.dev` : ''
  const defaultBaseUrl = defaultDomain ? `https://${defaultDomain}` : ''
  const baseUrl = domain ? `https://${domain}` : defaultBaseUrl
  if (!baseUrl) throw new BootstrapError('拿不到 workers.dev 子域，且未配置自定义域名')

  // 构建机拉清单地址：优先采用稳定默认域名（直连 Cloudflare 内部边缘网络，零外部 DNS 依赖）
  const manifestUrl = `${defaultBaseUrl || baseUrl}/admin/build-manifest`

  const adminToken = customAdminToken || randomBytes(32).toString('base64url')
  // 构建机拉清单的专用令牌一律自动生成：以前它是可选项，不配就退回「把 ADMIN_TOKEN 当
  // MANIFEST_TOKEN 用」——等于默认把面板登录凭证发给构建环境。没有理由把这个留给用户决定。
  const resolvedBuildToken = buildToken || randomBytes(32).toString('base64url')
  await step('写入 Worker 密钥与资源配置', () => {
    writeSecrets({
      repoRoot,
      token,
      accountId,
      workerName,
      secrets: {
        ADMIN_TOKEN: adminToken,
        CF_ACCOUNT_ID: accountId,
        CF_WORKER_NAME: workerName,
        CF_DEFAULT_DOMAIN: defaultDomain,
        CF_KV_ID: kv.id,
        CF_D1_ID: d1?.id || '',
        CF_R2_NAME: r2?.name || '',
        CF_CUSTOM_DOMAIN: domain || '',
        // 构建机拉清单用的专用令牌（Worker 侧叫 BUILD_TOKEN，构建机侧叫 MANIFEST_TOKEN）。
        // 不配的话构建机只能拿面板主密钥当 MANIFEST_TOKEN——那等于把面板登录凭证交给构建环境。
        BUILD_TOKEN: resolvedBuildToken,
        ...(buildsToken ? { CF_BUILDS_TOKEN: buildsToken } : {}),
      },
    })
  })

  if (qq?.appId && qq?.secret) {
    await step('保存 QQ 凭证（先向 QQ 验证）', () => putBotConfig({ baseUrl, adminToken, appId: qq.appId, secret: qq.secret }))
  }

  return {
    accountId,
    workerName,
    baseUrl,
    defaultDomain,
    domain: domain || null,
    panelUrl: `${baseUrl}/`,
    webhookUrl: `${baseUrl}/webhook`,
    manifestUrl,
    adminToken,
    /** 构建机侧的 MANIFEST_TOKEN 用它，不是面板主密钥 */
    buildToken: resolvedBuildToken,
    /** 构建 token 的预填创建链接（向导第 ④ 步那个按钮） */
    buildsTokenUrl: buildsTokenUrl(accountId, `${workerName}-builds`),
    resources: {
      kv: kv ? { name: kvTarget, id: kv.id, created: kv.created } : null,
      d1: d1 ? { name: d1Target, id: d1.id, created: d1.created } : null,
      r2: r2 ? { name: r2.name, created: r2.created } : null,
    },
    buildsTokenWritten: !!buildsToken,
    qqSaved: !!(qq?.appId && qq?.secret),
    isCustomAdminToken: Boolean(customAdminToken),
    warnings,
  }
}
