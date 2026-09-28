/** Cloudflare REST：统一的请求与报错，以及引导开头那几个只读查询（token、账户、权限、子域） */

import { redactApiPath, redactIds } from './redact.mjs'

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
    // 报错会进公开日志：路径里的账户 ID、trigger / build uuid 不带出去，错误信息里夹带的 id 也遮掉
    throw new BootstrapError(`Cloudflare API ${method} ${redactApiPath(apiPath)} 失败：${redactIds(detail)}`, {
      status: res.status,
      errors: envelope.errors ?? [],
    })
  }
  return envelope.result
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
 * 权限试探的端点。key 是 SETUP_TOKEN_URL 里对应的权限组，网页向导按它在权限清单上点名缺了哪项。
 * R2 未激活的账号那条必 4xx，不算缺权限——留给创建阶段降级。
 */
const PERMISSION_PROBES = [
  { key: 'workers_scripts', label: 'Workers Scripts（读）', path: (a) => `/accounts/${a}/workers/scripts` },
  { key: 'workers_kv_storage', label: 'KV Storage（读）', path: (a) => `/accounts/${a}/storage/kv/namespaces?per_page=1` },
  { key: 'd1', label: 'D1（读）', path: (a) => `/accounts/${a}/d1/database?per_page=1` },
  { key: 'workers_r2', label: 'R2（读）', path: (a) => `/accounts/${a}/r2/buckets?per_page=1`, optional: true },
]

/**
 * 权限试探：逐个 GET 只读端点，失败即缺权限。返回缺的那几项 `{ key, label }`（空数组 = 通过）。
 *
 * **只能证明「读」权限**：GET 通过不代表 Edit 存在，缺 Edit 要等真正部署时才报 403。
 * 所以这个结果不是「权限齐备」的保证——请按 README 的权限清单创建 token（引导链接已预填全部权限）。
 * account_settings 的读权限由 listAccounts 能否拿到该账户隐式验证，这里不再单独试探。
 */
export async function probeMissingPermissions(token, accountId) {
  const missing = []
  for (const probe of PERMISSION_PROBES) {
    try {
      await cfFetch(token, probe.path(accountId))
    } catch {
      if (!probe.optional) missing.push({ key: probe.key, label: probe.label })
    }
  }
  return missing
}

/** 同 probeMissingPermissions，只要名字（拼进报错与日志） */
export async function probePermissions(token, accountId) {
  return (await probeMissingPermissions(token, accountId)).map((p) => p.label)
}

/** workers.dev 子域（拼面板/回调地址用） */
export async function getWorkersSubdomain(token, accountId) {
  const result = await cfFetch(token, `/accounts/${accountId}/workers/subdomain`)
  return result?.subdomain ?? null
}
