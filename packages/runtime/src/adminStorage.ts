/**
 * GET /admin/storage —— 每个插件占了多少存储，以及不属于任何已装插件的孤儿数据。
 *
 * 卸载默认保留数据（误删不可逆），所以必须有个地方**看得见**这些残留并能清掉，
 * 否则"保留"就等于"永远管不了"。
 */
import type { AdminDeps } from './admin.js'
import { error, json } from './http.js'
import { listInstalls, listManifestPlugins } from './manifestStore.js'
import { collectUsage, purgePluginData, type StorageUsage } from './purge.js'
import type { RequestScope } from './scope.js'

/** 「装着的」＝ 已编译进本次部署的，加上写进 D1 清单、等下次构建生效的 */
async function activePlugins(scope: RequestScope, deps: AdminDeps): Promise<Set<string>> {
  const active = new Set(deps.registry.all().map((p) => p.manifest.name))
  if (scope.env.DB) for (const p of await listManifestPlugins(scope.env.DB)) active.add(p.name)
  return active
}

export async function storageReport(scope: RequestScope, deps: AdminDeps): Promise<Response> {
  const active = await activePlugins(scope, deps)

  // 卸载过的插件在账本里留了名字——D1 表名切不出归属，正好靠它认领
  const known = new Set(active)
  if (scope.env.DB) for (const r of await listInstalls(scope.env.DB, 200)) if (r.name) known.add(r.name)

  const { usage, unattributedTables } = await collectUsage(scope.env, [...known])
  const all = [...usage.values()].sort((a, b) => a.plugin.localeCompare(b.plugin))
  const nonEmpty = (u: StorageUsage): boolean => u.kvKeys > 0 || u.tables.length > 0 || u.r2Objects > 0

  return json({
    ok: true,
    bindings: { kv: true, d1: !!scope.env.DB, r2: !!scope.env.R2 },
    plugins: all.filter((u) => active.has(u.plugin)),
    orphans: all.filter((u) => !active.has(u.plugin) && nonEmpty(u)),
    unattributedTables,
  })
}

/** DELETE /admin/storage/orphans/:name —— 清掉已卸载插件的残留数据 */
export async function purgeOrphan(name: string, scope: RequestScope, deps: AdminDeps): Promise<Response> {
  if ((await activePlugins(scope, deps)).has(name)) {
    return error(`${name} 仍装着，请先卸载插件再清数据`, 409)
  }
  const purged = await purgePluginData(name, scope.env)
  return json({ ok: true, plugin: name, ...purged })
}
