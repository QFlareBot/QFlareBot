/**
 * 引导部署核心库（headless.mjs 与 wizard.mjs 共用）。
 *
 * 职责：校验 API token → 推导账户 → 幂等创建/复用 KV / D1 / R2 → 构建 + 部署 Worker
 * （环境变量动态注入基础设施绑定，零 Git 污染）→ wrangler secret bulk 写入运行时密钥。
 * QQ 机器人不在引导里建：部署完到面板「设置」里扫码创建或填入已有的凭证。
 *
 * 设计约束：
 * - 幂等：资源按名字查到即复用；重跑只补缺，零 Git 污染
 * - token 只经环境变量/内存传递，绝不打印、绝不落盘
 * - R2 创建失败（未激活/无权限）降级为去掉 R2 绑定而不是整体失败
 * - 公开仓库的 Actions 日志与 Step Summary 谁都能看：账户 ID、workers.dev 子域、资源 id 一拿到就
 *   打码（maskInLog），Summary 用 renderSummary 的 publicView 渲染，不带任何地址与标识
 */

import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
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

/** `/accounts/<id>/...` → `/accounts/…/...` */
export function redactAccountPath(apiPath) {
  return apiPath.replace(/\/accounts\/[^/?]+/, '/accounts/…')
}

/**
 * 让 GitHub Actions 在之后的日志里把这个值替换成 `***`。
 * 兜住子进程的输出：wrangler 部署时会打印 workers.dev 地址和 KV / D1 的 id，这些都进公开日志。
 * 只对日志生效，Step Summary 不打码——Summary 靠 renderSummary 的 publicView 不写这些值。
 */
export function maskInLog(value) {
  if (value && process.env.GITHUB_ACTIONS === 'true') console.log(`::add-mask::${value}`)
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
    // 报错会进公开日志：路径里的账户 ID 不带出去
    throw new BootstrapError(`Cloudflare API ${method} ${redactAccountPath(apiPath)} 失败：${detail}`, {
      status: res.status,
      errors: envelope.errors ?? [],
    })
  }
  return envelope.result
}

/** 面板登录密钥的最短长度：面板挂在公网上，太短的密码经不起猜 */
export const ADMIN_TOKEN_MIN_LENGTH = 12

/**
 * 管理密钥必须由用户自己给，引导不代为生成。
 *
 * 生成出来的值没有安全的途径交到用户手上：公开仓库的 Actions 日志与 Step Summary
 * 谁都能看，向导页面也只是一条临时隧道。用户自己定、自己记，引导全程只把它写进
 * Worker Secret，不回显、不输出。
 *
 * @returns {string | null} 不合格时的说明；合格为 null
 */
export function adminTokenProblem(token) {
  if (!token) return '缺少管理密钥 ADMIN_TOKEN：它就是面板登录密码，请自己设置一个（引导不会代为生成）'
  if (token.length < ADMIN_TOKEN_MIN_LENGTH) {
    return `管理密钥至少 ${ADMIN_TOKEN_MIN_LENGTH} 个字符：面板在公网上，太短的密码容易被猜中`
  }
  return null
}

/** 验证 token 本身有效且激活（这个端点只收 GET，POST 会报 7001） */
export async function verifyToken(token) {
  const result = await cfFetch(token, '/user/tokens/verify')
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

/** 已安装插件集所在的 D1 表；表名与列由 lib.test.mjs 断言与 packages/runtime/src/manifestStore.ts 一致 */
export const MANIFEST_PLUGINS_TABLE = 'rt_manifest_plugins'

/**
 * 读 D1 里已安装的插件集（与 /admin/build-manifest 读的是同一张表）。
 *
 * 引导的部署要是只打包仓库内置清单，重跑一次就会把面板里装的插件从线上抹掉
 * （数据还在 D1，插件不跑了），要等下一次构建才回来。这里直接读 D1、不走线上 Worker 的
 * 构建清单端点：主 token 本来就有 D1 权限，线上 Worker 的鉴权引导却不一定拿得到
 * （向导重跑时管理密钥可能是新生成的）；Worker 删过、D1 还留着的情况也只有这条路读得到。
 *
 * 表不存在（新库、从没装过插件）= 空集；其余失败照常抛出，不猜。
 */
export async function readInstalledPlugins(token, accountId, databaseId) {
  const query = async (sql, params = []) => {
    const result = await cfFetch(token, `/accounts/${accountId}/d1/database/${databaseId}/query`, {
      method: 'POST',
      body: { sql, params },
    })
    return result?.[0]?.results ?? []
  }
  const tables = await query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [MANIFEST_PLUGINS_TABLE])
  if (!tables.length) return []
  const rows = await query(`SELECT name, version, source FROM ${MANIFEST_PLUGINS_TABLE} ORDER BY name`)
  return rows.map((r) => ({ name: r.name, version: r.version, source: r.source }))
}

/** Worker 上已有的 secret 名（值本来也读不到） */
export async function listWorkerSecretNames(token, accountId, workerName) {
  const result = await cfFetch(token, `/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}/secrets`)
  return (result ?? []).map((s) => s.name)
}

/**
 * 这次该给 Worker 写哪个 BUILD_TOKEN。
 *
 * 它在构建 trigger 的 MANIFEST_TOKEN 里有一份副本，而 Worker 往 trigger 写只写一次（KV 打标）。
 * 所以 Worker 上已经有了就**沿用、不轮换**：重跑换掉它，trigger 那份不会跟着变，之后每次构建
 * 拉清单都 401、硬失败。显式给了（BUILD_TOKEN secret）才覆盖——那是用户自己在对齐两边。
 *
 * @returns {{ value: string, reused: false } | { value: null, reused: true }}
 */
export function resolveBuildToken({ explicit, existingSecretNames }) {
  if (explicit) return { value: explicit, reused: false }
  if (existingSecretNames.includes('BUILD_TOKEN')) return { value: null, reused: true }
  return { value: randomBytes(32).toString('base64url'), reused: false }
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

/**
 * installedPlugins：D1 里已安装的插件集，写成文件经 MANIFEST_FILE 交给 prepare，与内置清单合并构建。
 * undefined = 这次没有 D1，只用内置清单。
 */
export async function buildAndDeploy({ repoRoot, token, accountId, workerName, bindings = {}, installedPlugins }) {
  const manifestFile = installedPlugins
    ? path.join(os.tmpdir(), `qqbot-installed-plugins-${randomBytes(6).toString('hex')}.json`)
    : undefined
  if (manifestFile) await writeFile(manifestFile, JSON.stringify({ plugins: installedPlugins }))
  const env = {
    CLOUDFLARE_API_TOKEN: token,
    CLOUDFLARE_ACCOUNT_ID: accountId,
    ...(workerName ? { CF_WORKER_NAME: workerName } : {}),
    ...(bindings.kvId ? { CF_KV_ID: bindings.kvId } : {}),
    ...(bindings.d1Id ? { CF_D1_ID: bindings.d1Id } : {}),
    ...(bindings.r2Name ? { CF_R2_NAME: bindings.r2Name } : {}),
    ...(manifestFile ? { MANIFEST_FILE: manifestFile } : {}),
    INITIAL_BOOTSTRAP: 'true',
  }
  try {
    await runAsync('pnpm', ['install', '--frozen-lockfile'], { cwd: repoRoot })
    await runAsync('pnpm', ['--filter', '@qqbot/seed', 'run', 'deploy:manifest'], { cwd: repoRoot, env })
  } finally {
    if (manifestFile) await rm(manifestFile, { force: true })
  }
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

// ── 汇总输出 ─────────────────────────────────────────────────────────────

/**
 * 主 token 的预填创建链接（权限组 key 已实测有效）。
 *
 * `workers_ci`（Workers 构建配置）是给网页向导第 ④ 步用的：检测仓库连接、把构建命令与
 * 清单环境变量写进 trigger、触发首次构建，都不必等用户先建好构建 token。无 UI 模式用不到它。
 */
export const SETUP_TOKEN_URL =
  'https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_kv_storage%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22d1%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_r2%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22account_settings%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22workers_ci%22%2C%22type%22%3A%22edit%22%7D%5D&accountId=*&zoneId=all&name=qflarebot-setup'

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
 * 推送时不必重建机器人的路径（trigger 的 Build watch paths → Exclude）：只改文档、模板、工作流
 * 不再白占一次构建。权威定义同样在 `packages/projector/src/builds.ts`，由那边的测试断言一致。
 */
export const BUILD_PATH_EXCLUDES = ['docs/*', 'templates/*', '.github/*', 'scripts/*', 'design-system/*', '*.md', 'LICENSE']

/** 在 trigger 已有的排除路径上补齐：API 没说 PATCH 数组是替换还是合并，按替换处理，用户自己加的不丢 */
export function mergePathExcludes(existing) {
  return [...new Set([...(existing ?? []), ...BUILD_PATH_EXCLUDES])]
}

/**
 * 构建 token 的预填创建链接。
 *
 * `permissionGroupKeys` 用的是 dash 自己那套短 key（跟 SETUP_TOKEN_URL 同一套），
 * **不是** `/accounts/{id}/tokens/permission_groups` 返回的 UUID。早先这里会去查那个端点
 * 再取 `key` 字段，两头都不成立：引导 token 没有 API Tokens Read 权限（必然 403），
 * 而那个端点的返回里也根本没有 `key` 字段——于是解析永远失败，页面永远退回
 * 「请手动勾选权限」，这个按钮从来没真正工作过。写死即可。
 *
 * Builds 权限的 key 是 `workers_ci`（控制台显示为「Workers 构建配置」，已实测）。
 * 早先写的 `workers_builds` 不是有效 key，控制台静默忽略，建出来的 token 只有
 * Workers Scripts 读权限，列 trigger 必然 403。
 */
export function buildsTokenUrl(accountId, tokenName) {
  const groups = [
    { key: 'workers_ci', type: 'edit' },
    { key: 'workers_scripts', type: 'read' },
  ]
  const params = new URLSearchParams()
  params.set('permissionGroupKeys', JSON.stringify(groups))
  params.set('accountId', accountId)
  params.set('zoneId', 'all')
  params.set('name', tokenName)
  return `https://dash.cloudflare.com/profile/api-tokens?${params.toString()}`
}

/**
 * 连接仓库的入口：Worker 设置页（Build 一栏的 Connect）。
 * 不是 `/production/builds`——那是构建记录页，用户到了那里找不到填构建命令的表单。
 */
export function buildsConnectUrl(accountId, workerName) {
  return `https://dash.cloudflare.com/${accountId}/workers/services/view/${encodeURIComponent(workerName)}/production/settings`
}

/** Worker 的 Domains & Routes / Triggers 设置页 */
export function workerDomainsUrl(accountId, workerName) {
  return `https://dash.cloudflare.com/${accountId}/workers/services/view/${encodeURIComponent(workerName)}/production/settings/triggers`
}

/** Worker 的构建记录页 */
export function workerBuildsUrl(accountId, workerName) {
  return `https://dash.cloudflare.com/${accountId}/workers/services/view/${encodeURIComponent(workerName)}/production/builds`
}

/**
 * 不带账户 ID 的 Worker 后台链接（`:account` 由 Cloudflare 后台换成当前登录的账户），给公开的 Summary 用。
 * sub：`settings`（Build 一栏、Domains & Routes 都在这页）/ `settings/triggers` / `builds`
 */
export function workerDashLink(workerName, sub = 'settings') {
  return `https://dash.cloudflare.com/?to=/:account/workers/services/view/${encodeURIComponent(workerName)}/production/${sub}`
}

// ── Workers Builds（网页向导第 ④ ⑤ 步） ───────────────────────────────────

/** 按脚本名找 Builds API 用的 tag——脚本名（id）与 tag 不是一回事 */
export async function findWorkerTag(token, accountId, workerName) {
  const scripts = await cfFetch(token, `/accounts/${accountId}/workers/scripts`)
  const me = (Array.isArray(scripts) ? scripts : scripts?.items ?? []).find((s) => s?.id === workerName)
  if (!me?.tag) throw new BootstrapError(`账户里找不到 Worker ${workerName}`)
  return me.tag
}

/**
 * 列 Worker 的 Builds trigger；仓库连上之前为空。
 *
 * 404 按「还没连接」处理（未连接时 Cloudflare 回什么没有文档，未实测）。
 * 403 抛出时带 `missingPermission`：它通常是缺 Workers 构建配置权限，但没连接时是否也回 403
 * 同样没有文档——所以连接前拿到 403 的调用方不该当场报红，见 wizard 的连接检测。
 *
 * @param who 报错里怎么称呼这个 token（「主 Token」「构建 Token」）
 */
export async function listTriggers(token, accountId, workerTag, who) {
  try {
    const triggers = await cfFetch(token, `/accounts/${accountId}/builds/workers/${workerTag}/triggers`)
    return Array.isArray(triggers) ? triggers : triggers?.items ?? []
  } catch (err) {
    if (!(err instanceof BootstrapError)) throw err
    if (err.status === 404) return []
    if (err.status === 403) {
      const denied = new BootstrapError(
        `${who}缺少「Workers 构建配置（编辑）」权限（英文界面叫 Workers Builds Configuration，也可能显示为 Workers CI）——` +
          '到 Cloudflare 的 API Tokens 页编辑这个 token 补上这项（token 值不变）',
        { status: 403 },
      )
      denied.missingPermission = true
      throw denied
    }
    throw err
  }
}

/**
 * 从 trigger 列表里挑生产 trigger，返回 { uuid, branch, pathExcludes }；没有则 null。
 *
 * 连接时勾了「非生产分支构建」，Cloudflare 会另建一个预览 trigger：branch_includes 是 ["*"]、
 * 排除生产分支。取列表第一个可能正好取到它——往里写 manifest:deploy，任何分支一推就切 100% 流量。
 * 生产 trigger 的 branch_includes 是具体分支名；字段缺失（响应形状变了）时按生产处理、分支记 main。
 * pathExcludes 是它现有的排除路径，写配置时在它上面合并。
 */
export function pickProductionTrigger(triggers) {
  for (const t of triggers ?? []) {
    const uuid = t?.trigger_uuid ?? t?.uuid ?? t?.id
    if (typeof uuid !== 'string' || !uuid) continue
    const includes = Array.isArray(t.branch_includes) ? t.branch_includes : []
    const pathExcludes = Array.isArray(t.path_excludes) ? t.path_excludes.filter((p) => typeof p === 'string') : []
    const branch = includes.find((b) => typeof b === 'string' && b && !b.includes('*'))
    if (branch) return { uuid, branch, pathExcludes }
    if (!includes.length) return { uuid, branch: 'main', pathExcludes }
  }
  return null
}

/**
 * 把构建命令、清单环境变量与排除路径写进 trigger。
 *
 * 这几项以前只出现在 Summary 的照抄块里，而向导用户那时早已离开 run 页：走完向导 →
 * 去面板装插件 → 构建机用默认命令跑 → 失败，面板上只显示「失败」。
 * 排除路径（BUILD_PATH_EXCLUDES）让只改文档的推送不再重建机器人。
 */
export async function configureTrigger(token, accountId, triggerUuid, { manifestUrl, buildToken, pathExcludes = [] }) {
  await cfFetch(token, `/accounts/${accountId}/builds/triggers/${triggerUuid}`, {
    method: 'PATCH',
    body: { build_command: BUILD_COMMAND, deploy_command: DEPLOY_COMMAND, path_excludes: mergePathExcludes(pathExcludes) },
  })
  await cfFetch(token, `/accounts/${accountId}/builds/triggers/${triggerUuid}/environment_variables`, {
    method: 'PATCH',
    body: {
      MANIFEST_URL: { value: manifestUrl, is_secret: false },
      MANIFEST_TOKEN: { value: buildToken, is_secret: true },
    },
  })
}

/** 手动触发一次构建，返回 build_uuid */
export async function startBuild(token, accountId, triggerUuid, branch) {
  const result = await cfFetch(token, `/accounts/${accountId}/builds/triggers/${triggerUuid}/builds`, {
    method: 'POST',
    body: { branch },
  })
  const buildUuid = result?.build_uuid ?? result?.uuid ?? result?.id
  if (typeof buildUuid !== 'string') throw new BootstrapError('触发构建的响应缺少 build_uuid')
  return buildUuid
}

/** 查一次构建的状态：{ status, outcome }；outcome 为空表示还在跑 */
export async function getBuild(token, accountId, buildUuid) {
  const b = await cfFetch(token, `/accounts/${accountId}/builds/builds/${buildUuid}`)
  return { status: b?.status ?? '', outcome: b?.build_outcome ?? '' }
}

/**
 * 把引导结果渲染成 Markdown 汇总。
 *
 * publicView：写进 GITHUB_STEP_SUMMARY 用。公开仓库的 Summary 谁都能看，而且 add-mask 管不到它——
 * 所以这一版一个地址、一个标识都不写：不列面板地址与 MANIFEST_URL（都带着账户的 workers.dev 子域），
 * 后台链接用 `:account` 占位（workerDashLink），资源只说新建还是复用，不写名字与 id。
 * 完整版只给网页向导的完成页（隧道页面只有认领了的那个浏览器打得开）和本地试跑。
 */
export function renderSummary(result, { redactSecrets = false, publicView = false } = {}) {
  const {
    panelUrl,
    manifestUrl,
    buildToken,
    buildTokenReused,
    resources,
    buildsTokenWritten,
    triggerConfigured,
    warnings,
    accountId,
    workerName,
  } = result
  const hideSecrets = redactSecrets || publicView
  const settingsLink = publicView ? workerDashLink(workerName) : buildsConnectUrl(accountId, workerName)
  const domainsLink = publicView ? workerDashLink(workerName, 'settings/triggers') : workerDomainsUrl(accountId, workerName)
  const resourceRow = (label, r) => `| ${label} | ${publicView ? '' : `${r.name}`}${r.created ? '（新建）' : '（复用已有）'} |`
  const lines = []
  lines.push('## ✅ 引导部署完成')
  lines.push('')
  if (publicView) {
    lines.push(
      '> 🔒 这一页谁都能看，所以不列面板地址、账户与资源标识。面板地址在 ' +
        `[Worker 后台](${domainsLink})的 Domains & Routes 里（\`${workerName}.<你的子域>.workers.dev\`）。`,
    )
    lines.push('')
  }
  lines.push('| 项目 | 值 |')
  lines.push('| --- | --- |')
  if (!publicView) {
    lines.push(`| 管理面板 | [${panelUrl}](${panelUrl}) |`)
    lines.push(`| 构建机拉清单地址（MANIFEST_URL） | \`${manifestUrl}\` |`)
  }
  if (resources.kv) lines.push(resourceRow('KV', resources.kv))
  if (resources.d1) lines.push(resourceRow('D1', resources.d1))
  if (resources.r2) lines.push(resourceRow('R2', resources.r2))
  lines.push('')
  lines.push(
    '**面板登录**：用你自己设置的 `ADMIN_TOKEN`（无 UI 模式是 GitHub Secret 里那个，网页向导是表单里填的）。' +
      '引导不会生成、也不会在任何地方输出它；忘了就 `wrangler secret put ADMIN_TOKEN` 重设。',
  )
  lines.push('')
  lines.push('### 下一步')
  lines.push('')
  // 域名由用户自己选、自己绑：引导不接收域名，部署也不声明 routes，绑上之后不会被任何部署路径改动。
  // 回调地址只给域名模板，不给 workers.dev 的——QQ 开放平台验证不通 *.workers.dev（已实测），给了只会让人白填一次
  lines.push(
    `1. **绑定自定义域名（必需）**：QQ 开放平台访问不到 \`*.workers.dev\`，回调必须走你自己的域名。` +
      `打开 [Cloudflare 域名设置页](${domainsLink})，在 **Custom Domains** 里添加一个` +
      '（域名要托管在这个 Cloudflare 账户下，如 `bot.yourdomain.com`）。之后的部署都不会改动你绑的域名。',
  )
  lines.push('')
  lines.push(
    '2. **创建或绑定 QQ 机器人**：用新域名打开面板，到「设置」里用手机 QQ 扫码新建一个，或填入已有机器人的 AppID / AppSecret。' +
      '然后在 [q.qq.com](https://q.qq.com) 机器人管理里把回调地址填成 `https://你的域名/webhook`（面板概览页可以一键复制）。',
  )
  lines.push('')
  if (triggerConfigured) {
    lines.push(
      `3. **构建配置已自动写入**：Build command、Deploy command、\`MANIFEST_URL\`、\`MANIFEST_TOKEN\` 与排除路径都已经通过 Builds API ` +
        `写进了这个 Worker 的构建 trigger，[后台](${settingsLink})一个格子都不用填。到面板装一个插件即可验证重建链路。`,
    )
  } else {
    lines.push(
      `3. **连接仓库**（装/卸插件触发重建的前置）：打开 [Worker 设置页](${settingsLink})，在 Build 一栏点 Connect，` +
        '选择本 fork 仓库，分支选默认分支，然后照抄下面几项。' +
        '（网页向导模式会在连接完成后自动写入，不必手抄；这里是无 UI 模式的兜底——' +
        '工作流跑的时候仓库还没连接，trigger 不存在，写不了。配好 `CF_BUILDS_TOKEN` 后，Worker 第一次从面板触发构建时也会自动补写。）',
    )
    lines.push('')
    lines.push('   ```')
    lines.push('   # Build command')
    lines.push(`   ${BUILD_COMMAND}`)
    lines.push('   # Deploy command')
    lines.push(`   ${DEPLOY_COMMAND}`)
    lines.push('   # Build watch paths → Exclude paths（只改这些时不重建机器人）')
    lines.push(`   ${BUILD_PATH_EXCLUDES.join('  ')}`)
    lines.push('   # 环境变量（Settings → Builds → Environment variables）')
    lines.push(`   MANIFEST_URL=${publicView ? `https://${workerName}.<你的子域>.workers.dev/admin/build-manifest` : manifestUrl}`)
    // Worker 侧叫 BUILD_TOKEN、构建机侧叫 MANIFEST_TOKEN，是同一个值——名字不一致最容易配错
    const manifestToken = buildTokenReused
      ? '<与 Worker 上已有的 BUILD_TOKEN 同值，见下>'
      : hideSecrets
        ? '<引导自动生成的 BUILD_TOKEN，见下>'
        : buildToken
    lines.push(`   MANIFEST_TOKEN=${manifestToken}`)
    lines.push('   ```')
    if (buildTokenReused) {
      lines.push('')
      lines.push(
        '   🔑 Worker 上已有 `BUILD_TOKEN`，本次沿用、没有轮换——构建机侧已经填好的 `MANIFEST_TOKEN` 保持不动即可。' +
          '还没填过的话：`wrangler secret put BUILD_TOKEN` 重设一个随机长字符串，再把 `MANIFEST_TOKEN` 填成同一个值。',
      )
    } else if (hideSecrets) {
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
  if (warnings.length) {
    lines.push('### ⚠️ 提醒')
    lines.push('')
    for (const w of warnings) lines.push(`- ${w}`)
    lines.push('')
  }
  lines.push('> 幂等：本工作流可随时重跑。重跑会复用同名资源，带上 D1 里已安装的插件，沿用已有的 BUILD_TOKEN。')
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
 *   buildsToken  可选，提供则写为 CF_BUILDS_TOKEN secret
 *   buildToken   可选，提供则写为 BUILD_TOKEN；不提供时 Worker 上已有就沿用，没有才生成
 *   adminToken   必填，面板登录密钥（见 adminTokenProblem）
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
    buildsToken,
    buildToken,
    adminToken,
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

  // 先于一切远端操作：密钥不合格就别建资源、别部署
  const adminProblem = adminTokenProblem(adminToken)
  if (adminProblem) throw new BootstrapError(adminProblem)

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

  await step('构建并部署 Worker', () => buildAndDeploy({ repoRoot, token, accountId, workerName, bindings, installedPlugins }))
  // 面板、构建机拉清单走默认域名：直连 Cloudflare 边缘，零外部 DNS 依赖。
  // 回调例外——QQ 开放平台访问不到 workers.dev，必须由用户另绑自定义域名（Summary 里说明）
  const baseUrl = `https://${defaultDomain}`
  const manifestUrl = `${baseUrl}/admin/build-manifest`

  // 构建机拉清单的专用令牌不留给用户决定：以前它是可选项，不配就退回「把 ADMIN_TOKEN 当
  // MANIFEST_TOKEN 用」——等于默认把面板登录凭证发给构建环境。首次自动生成，重跑沿用（见 resolveBuildToken）
  const existingSecrets = await step('查询 Worker 已有密钥', () => listWorkerSecretNames(token, accountId, workerName))
  const buildTokenPlan = resolveBuildToken({ explicit: buildToken, existingSecretNames: existingSecrets })
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
    /** 构建 token 的预填创建链接（向导第 ④ 步那个按钮） */
    buildsTokenUrl: buildsTokenUrl(accountId, `${workerName}-builds`),
    /** 连接仓库的入口（向导第 ④ 步第二个按钮） */
    buildsConnectUrl: buildsConnectUrl(accountId, workerName),
    resources: {
      kv: kv ? { name: kvTarget, id: kv.id, created: kv.created } : null,
      d1: d1 ? { name: d1Target, id: d1.id, created: d1.created } : null,
      r2: r2 ? { name: r2.name, created: r2.created } : null,
    },
    buildsTokenWritten: !!buildsToken,
    warnings,
  }
}
