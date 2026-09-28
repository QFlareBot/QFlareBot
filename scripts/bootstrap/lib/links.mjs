/** Cloudflare 后台的预填链接：主 token、构建 token 的创建页，Worker 的设置、域名、构建记录页 */

/**
 * 主 token 的预填创建链接（权限组 key 已实测有效）。
 *
 * `workers_ci`（Workers 构建配置）是给网页向导第 ④ 步用的：检测仓库连接、把构建命令与
 * 清单环境变量写进 trigger、触发首次构建，都不必等用户先建好构建 token。无 UI 模式用不到它。
 */
export const SETUP_TOKEN_URL =
  'https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_kv_storage%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22d1%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_r2%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22account_settings%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22workers_ci%22%2C%22type%22%3A%22edit%22%7D%5D&accountId=*&zoneId=all&name=qflarebot-setup'

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
 *
 * `workers_observability`（Workers Observability 编辑，已实测能自动勾上）给面板读 Workers Logs：
 * 最近事件与 24 小时统计都从日志查，查询接口只认编辑权限。缺了只是看不到，不影响构建。
 */
export function buildsTokenUrl(accountId, tokenName) {
  const groups = [
    { key: 'workers_ci', type: 'edit' },
    { key: 'workers_scripts', type: 'read' },
    { key: 'workers_observability', type: 'edit' },
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
