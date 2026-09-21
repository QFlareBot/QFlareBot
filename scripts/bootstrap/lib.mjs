#!/usr/bin/env node
/**
 * 引导部署核心库（headless.mjs 与 wizard.mjs 共用）。
 *
 * 职责：校验 API token → 推导账户 → 幂等创建/复用 KV / D1 / R2 → 把资源 id 与
 * 自定义域名写回 apps/seed/wrangler.jsonc（保留注释，单行手术）→ commit 回 fork →
 * 构建 + wrangler deploy → wrangler secret bulk 写入运行时密钥 → 可选把 QQ 凭证
 * 存进 KV（与管理面板同一条 PUT /admin/bot 路径，先向 QQ 验证）。
 *
 * 设计约束：
 * - 幂等：资源按名字查到即复用；重跑只补缺（配置文件已是目标值则不产生 commit）
 * - token 只经环境变量/内存传递，绝不打印、绝不落盘
 * - R2 创建失败（未激活/无权限）降级为去掉 R2 绑定而不是整体失败
 */

import { spawnSync } from 'node:child_process'
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
 * 返回 missing 列表（空数组 = 通过）。account_settings 的读权限由
 * listAccounts 能否拿到该账户隐式验证，这里不再单独试探。
 */
export async function probePermissions(token, accountId) {
  const probes = [
    { label: 'Workers Scripts（编辑）', path: `/accounts/${accountId}/workers/scripts`, r2: false },
    { label: 'KV Storage（编辑）', path: `/accounts/${accountId}/storage/kv/namespaces?per_page=1`, r2: false },
    { label: 'D1（编辑）', path: `/accounts/${accountId}/d1/database?per_page=1`, r2: false },
    // R2 未激活的账号这条必 4xx，不算缺权限——留给创建阶段降级
    { label: 'R2（编辑）', path: `/accounts/${accountId}/r2/buckets?per_page=1`, r2: true },
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

// ── wrangler.jsonc 回写：保留注释的单行手术 ────────────────────────────────
// 模板里 kv_namespaces / d1_databases / r2_buckets / vars 都是"一行一个值"。
// 读值 → 比较目标值 → 相同不动（幂等）、不同整行替换、行不存在按锚点插入
// （降级移除后重跑引导能恢复）。锚点找不到就大声失败，避免静默改错地方。

function readLineValue(text, key) {
  const re = new RegExp(`^ {2}"${key}": (.*?)(,?)$`, 'm')
  const m = re.exec(text)
  if (!m) return null
  try {
    return JSON.parse(m[1])
  } catch {
    throw new BootstrapError(`wrangler.jsonc 的 "${key}" 行解析失败——模板可能被改过，请对照上游模板`)
  }
}

function writeLineValue(text, key, value, anchorRe) {
  const serialized = JSON.stringify(value)
  const full = `  "${key}": ${serialized},`
  const re = new RegExp(`^ {2}"${key}": .*$`, 'm')
  if (re.test(text)) {
    if (JSON.stringify(readLineValue(text, key)) === serialized) return text
    return text.replace(re, full)
  }
  if (!anchorRe) throw new BootstrapError(`wrangler.jsonc 找不到 "${key}" 行，也没有插入锚点——请对照上游模板`)
  const a = anchorRe.exec(text)
  if (!a) throw new BootstrapError(`wrangler.jsonc 找不到 "${key}" 行的插入锚点——请对照上游模板`)
  return text.slice(0, a.index + a[0].length) + '\n' + full + text.slice(a.index + a[0].length)
}

function dropLine(text, key, comment) {
  const re = new RegExp(`^ {2}"${key}": .*$`, 'm')
  if (!re.test(text)) return text
  return text.replace(re, `  // ${comment}`)
}

/**
 * 把引导结果写回 wrangler.jsonc 文本。
 * patch：{ name?, kvId?, d1?: {name, id} | null（null=移除）, r2?: {name} | null,
 *         domain?: string（配了则 routes + workers_dev=false；未配则清掉 routes 行） }
 * 返回 { text, changed }
 */
export function patchWranglerConfig(text, patch) {
  let out = text
  const kvAnchor = /^ {2}"kv_namespaces": .*$/m

  if (patch.name && readLineValue(out, 'name') !== patch.name) {
    out = writeLineValue(out, 'name', patch.name)
  }

  if (patch.kvId) {
    const kv = readLineValue(out, 'kv_namespaces')
    if (!Array.isArray(kv) || !kv[0]) throw new BootstrapError('wrangler.jsonc 缺少 kv_namespaces 数组')
    if (kv[0].id !== patch.kvId) {
      kv[0].id = patch.kvId
      out = writeLineValue(out, 'kv_namespaces', kv)
    }
  }

  if (patch.d1 === null) {
    out = dropLine(out, 'd1_databases', 'd1_databases 已按引导配置移除（重跑引导可恢复，或手工加回）')
  } else if (patch.d1) {
    const existing = readLineValue(out, 'd1_databases')
    const entry = {
      binding: Array.isArray(existing) && existing[0]?.binding ? existing[0].binding : 'DB',
      database_name: patch.d1.name,
      database_id: patch.d1.id,
    }
    if (JSON.stringify(existing) !== JSON.stringify([entry])) {
      out = writeLineValue(out, 'd1_databases', [entry], kvAnchor)
    }
  }

  if (patch.r2 === null) {
    out = dropLine(out, 'r2_buckets', 'r2_buckets 已按引导配置移除（R2 未激活或创建失败；重跑引导可恢复）')
  } else if (patch.r2) {
    const existing = readLineValue(out, 'r2_buckets')
    const entry = { binding: Array.isArray(existing) && existing[0]?.binding ? existing[0].binding : 'R2', bucket_name: patch.r2.name }
    if (JSON.stringify(existing) !== JSON.stringify([entry])) {
      out = writeLineValue(out, 'r2_buckets', [entry], /^ {2}"d1_databases": .*$/m.test(out) ? /^ {2}"d1_databases": .*$/m : kvAnchor)
    }
  }

  if (patch.name) {
    const vars = readLineValue(out, 'vars')
    if (vars && typeof vars === 'object' && !Array.isArray(vars)) {
      if (vars.WORKER_NAME !== patch.name) {
        vars.WORKER_NAME = patch.name
        out = writeLineValue(out, 'vars', vars)
      }
    } else {
      out = writeLineValue(out, 'vars', { WORKER_NAME: patch.name }, /^ {2}"observability": .*$/m)
    }
  }

  if (patch.domain) {
    const routesValue = [{ pattern: patch.domain, custom_domain: true }]
    if (JSON.stringify(readLineValue(out, 'routes')) !== JSON.stringify(routesValue)) {
      out = writeLineValue(out, 'routes', routesValue, /^ {2}"workers_dev": .*$/m)
    }
    if (readLineValue(out, 'workers_dev') !== false) {
      out = writeLineValue(out, 'workers_dev', false)
    }
  }
  // 未传 domain = 保持现状（重跑不填域名不会丢掉已配置的域名；要删域名手工改配置）

  return { text: out, changed: out !== text }
}

// ── 命令执行 ─────────────────────────────────────────────────────────────

function run(cmd, args, { cwd, env = {} } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  })
  if (r.status !== 0) throw new BootstrapError(`命令失败（退出码 ${r.status}）：${cmd} ${args.join(' ')}`)
}

export function buildAndDeploy({ repoRoot, token, accountId }) {
  run('pnpm', ['install', '--frozen-lockfile'], { cwd: repoRoot })
  run('pnpm', ['build'], { cwd: repoRoot })
  run('pnpm', ['--filter', '@qqbot/seed', 'run', 'deploy'], { cwd: repoRoot, env: { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId } })
}

/** 部署后写 Worker secrets（wrangler secret bulk，stdin 传 JSON）；token 仅用于 wrangler 鉴权 */
export function writeSecrets({ repoRoot, secrets, token, accountId }) {
  const entries = Object.entries(secrets).filter(([, v]) => typeof v === 'string' && v.length > 0)
  if (!entries.length) return
  const payload = JSON.stringify(Object.fromEntries(entries))
  const seedDir = path.join(repoRoot, 'apps', 'seed')
  const r = spawnSync('npx', ['wrangler', 'secret', 'bulk'], {
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

/** 把回写的配置 commit 进 fork；无变更返回 false。默认只在 Actions 里 push，本地试跑不推 */
export function commitBack({ repoRoot, message, push = process.env.GITHUB_ACTIONS === 'true' }) {
  run('git', ['config', 'user.name', 'github-actions[bot]'], { cwd: repoRoot })
  run('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'], { cwd: repoRoot })
  run('git', ['add', 'apps/seed/wrangler.jsonc'], { cwd: repoRoot })
  const diff = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: repoRoot })
  if (diff.status === 0) return false
  run('git', ['commit', '-m', message], { cwd: repoRoot })
  if (push) run('git', ['push', 'origin', 'HEAD'], { cwd: repoRoot })
  return true
}

// ── 汇总输出 ─────────────────────────────────────────────────────────────

/** 主 token 的预填创建链接（权限组 key 已实测有效） */
export const SETUP_TOKEN_URL =
  'https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_kv_storage%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22d1%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_r2%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22account_settings%22%2C%22type%22%3A%22read%22%7D%5D&accountId=*&zoneId=all&name=qqbot-setup'

/** Workers Builds 后台的连接页（worker 详情 → Builds） */
export function buildsConnectUrl(accountId, workerName) {
  return `https://dash.cloudflare.com/${accountId}/workers/services/view/${encodeURIComponent(workerName)}/production/builds`
}

/** 把引导结果渲染成 Markdown 汇总（GITHUB_STEP_SUMMARY / 向导完成页共用） */
export function renderSummary(result) {
  const { baseUrl, panelUrl, webhookUrl, manifestUrl, adminToken, resources, buildsTokenWritten, qqSaved, warnings, accountId, workerName } = result
  const lines = []
  lines.push('## ✅ 引导部署完成')
  lines.push('')
  lines.push('| 项目 | 值 |')
  lines.push('| --- | --- |')
  lines.push(`| 管理面板 | ${panelUrl} |`)
  lines.push(`| 回调地址（填到 QQ 开放平台） | \`${webhookUrl}\` |`)
  lines.push(`| 构建机拉清单地址 | \`${manifestUrl}\` |`)
  if (resources.kv) lines.push(`| KV | ${resources.kv.name}${resources.kv.created ? '（新建）' : '（复用已有）'} |`)
  if (resources.d1) lines.push(`| D1 | ${resources.d1.name}${resources.d1.created ? '（新建）' : '（复用已有）'} |`)
  if (resources.r2) lines.push(`| R2 | ${resources.r2.name}${resources.r2.created ? '（新建）' : '（复用已有）'} |`)
  lines.push('')
  lines.push('<details><summary><b>ADMIN_TOKEN</b>（面板登录密钥，只在这里显示一次）</summary>')
  lines.push('')
  lines.push('```')
  lines.push(adminToken)
  lines.push('```')
  lines.push('')
  lines.push('</details>')
  lines.push('')
  lines.push('### 下一步')
  lines.push('')
  lines.push(`1. **连接仓库**（装/卸插件触发重建的前置）：打开 [Workers Builds 设置页](${buildsConnectUrl(accountId, workerName)}) → Connect，选择本 fork 仓库，分支选默认分支，然后照抄：`)
  lines.push('')
  lines.push('   ```')
  lines.push('   # Build command')
  lines.push('   pnpm build && pnpm --filter @qqbot/seed run manifest:prepare')
  lines.push('   # Deploy command')
  lines.push('   pnpm --filter @qqbot/seed run manifest:deploy')
  lines.push('   # 环境变量（Settings → Builds → Environment variables）')
  lines.push(`   MANIFEST_URL=${manifestUrl}`)
  lines.push(`   MANIFEST_TOKEN=${adminToken}`)
  lines.push('   ```')
  if (buildsTokenWritten) {
    lines.push('')
    lines.push('   构建凭证 `CF_BUILDS_TOKEN` 已写入 Worker，装插件时自动触发重建。')
  } else {
    lines.push('')
    lines.push('   **尚未配置 `CF_BUILDS_TOKEN`**（Worker 触发重建用）：创建一个 user token（权限：Workers Builds Configuration Edit + Workers Scripts Read，账户范围限本账户），`wrangler secret put CF_BUILDS_TOKEN` 写入，或重跑引导时带上。配置后到面板装一个插件即可验证重建链路。')
  }
  lines.push('')
  lines.push(`2. **QQ 开放平台**：在 [q.qq.com](https://q.qq.com) 机器人管理里把回调地址填成 \`${webhookUrl}\`${qqSaved ? '。QQ 凭证已在引导时保存进 KV。' : '，再到管理面板 → 设置里保存 AppID/AppSecret（存 KV）。'}`)
  lines.push('')
  if (warnings.length) {
    lines.push('### ⚠️ 提醒')
    lines.push('')
    for (const w of warnings) lines.push(`- ${w}`)
    lines.push('')
  }
  lines.push('> 幂等：本工作流可随时重跑。重跑会复用同名资源、保持已回写的配置；重跑时填了新的自定义域名会切换域名。')
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

  // 资源名：未填 = 用默认名；'none' = 显式跳过该资源（不绑定）
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

  const configPath = path.join(repoRoot, 'apps', 'seed', 'wrangler.jsonc')
  await step('回写 wrangler.jsonc', async () => {
    const text = await readFile(configPath, 'utf8')
    const { text: next, changed } = patchWranglerConfig(text, {
      name: workerName !== 'qqbot' ? workerName : undefined,
      kvId: kv.id,
      // d1/r2 为 null = 从配置里移除（显式跳过，或 R2 创建失败降级）
      d1: d1 ? { name: d1Target, id: d1.id } : null,
      r2: r2 ? { name: r2.name } : null,
      domain,
    })
    if (changed) await writeFile(configPath, next)
    return changed
  })

  await step('提交回写配置', () => {
    const committed = commitBack({ repoRoot, message: 'chore(bootstrap): 写入资源 id 与部署配置 [skip ci]' })
    if (!committed) warnings.push('配置无变化，未产生新提交（幂等重跑）')
    return committed
  })

  await step('构建并部署 Worker', () => buildAndDeploy({ repoRoot, token, accountId }))

  const subdomain = await step('查询 workers.dev 子域', () => getWorkersSubdomain(token, accountId))
  const baseUrl = domain ? `https://${domain}` : `https://${workerName}.${subdomain}.workers.dev`
  if (!domain && !subdomain) throw new BootstrapError('拿不到 workers.dev 子域，且未配置自定义域名')

  const adminToken = randomBytes(32).toString('base64url')
  await step('写入 Worker 密钥', () => {
    writeSecrets({
      repoRoot,
      token,
      accountId,
      secrets: {
        ADMIN_TOKEN: adminToken,
        CF_ACCOUNT_ID: accountId,
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
    panelUrl: `${baseUrl}/`,
    webhookUrl: `${baseUrl}/webhook`,
    manifestUrl: `${baseUrl}/admin/build-manifest`,
    adminToken,
    resources: {
      kv: kv ? { name: kvTarget, id: kv.id, created: kv.created } : null,
      d1: d1 ? { name: d1Target, id: d1.id, created: d1.created } : null,
      r2: r2 ? { name: r2.name, created: r2.created } : null,
    },
    buildsTokenWritten: !!buildsToken,
    qqSaved: !!(qq?.appId && qq?.secret),
    warnings,
  }
}
