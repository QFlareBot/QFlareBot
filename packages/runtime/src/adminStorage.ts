/**
 * GET /admin/storage —— 每个插件占了多少存储，以及不属于任何已装插件的孤儿数据。
 *
 * 卸载默认保留数据（误删不可逆），所以必须有个地方**看得见**这些残留并能清掉，
 * 否则"保留"就等于"永远管不了"。
 */
import type { AdminDeps } from './admin.js'
import { error, json } from './http.js'
import { listManifestPlugins } from './manifestStore.js'
import { collectUsage, describeRemaining, knownPluginNames, purgeComplete, purgePluginData, type StorageUsage } from './purge.js'
import type { RequestScope } from './scope.js'

/** 「装着的」＝ 已编译进本次部署的，加上写进 D1 清单、等下次构建生效的 */
async function activePlugins(scope: RequestScope, deps: AdminDeps): Promise<Set<string>> {
  const active = new Set(deps.registry.all().map((p) => p.manifest.name))
  if (scope.env.DB) for (const p of await listManifestPlugins(scope.env.DB)) active.add(p.name)
  return active
}

export async function storageReport(scope: RequestScope, deps: AdminDeps): Promise<Response> {
  const active = await activePlugins(scope, deps)

  // 卸载过的插件在账本、待收尾里留了名字——D1 表名切不出归属，正好靠它认领。
  // 与清数据用的是同一份名单（knownPluginNames）；KV/R2 键名反推的由 collectUsage 顺手并进去
  const known = await knownPluginNames(scope.env, deps.registry)
  for (const name of active) known.add(name)

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

/**
 * DELETE /admin/storage/orphans/:name —— 清掉已卸载插件的残留数据。
 *
 * 一次只删一批（单次调用的操作数有上限，见 purge.ts）：没删完时 `done: false`，`kvRemaining` 等字段
 * 说还剩多少，`message` 提示再点一次。老面板不认这几个字段也无妨——它清完就刷新存储页，剩下的照样列成孤儿。
 */
export async function purgeOrphan(name: string, scope: RequestScope, deps: AdminDeps): Promise<Response> {
  const active = await activePlugins(scope, deps)
  if (active.has(name)) {
    return error(`${name} 仍装着，请先卸载插件再清数据`, 409)
  }
  // 与卸载清数据同一份「已知插件名」：表前缀可能碰撞或嵌套（`my-plugin` vs `my_plugin`、`game` vs `game_stats`），
  // 少了谁就分不清一张表属于谁，宁可留孤儿也不能误删
  const known = await knownPluginNames(scope.env, deps.registry)
  let purged
  try {
    purged = await purgePluginData(name, scope.env, known)
  } catch (err) {
    // 以前这里直接抛成笼统的 500；删到一半的数据回不来，但再点一次会接着删
    const message = err instanceof Error ? err.message : String(err)
    deps.logger.warn('清孤儿数据中途失败', { plugin: name, error: message })
    return error(`清 ${name} 的数据中途失败：${message}。已经删掉的不会恢复，稍后再点一次会接着清`, 500)
  }
  const done = purgeComplete(purged)
  const remaining = describeRemaining(purged)
  return json({
    ok: true,
    plugin: name,
    ...purged,
    done,
    ...(remaining ? { message: `${name} 的数据${remaining}没清（一次只清一批），再点一次接着清` } : {}),
  })
}
