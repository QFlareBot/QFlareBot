/** 存储资源：KV / D1 / R2 按名字查到即复用、缺了才建；以及 D1 里已安装的插件集 */

import { cfFetch } from './cf.mjs'

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

/** D1：按名称查找，只读；没有返回 null */
export async function findD1(token, accountId, name) {
  let page = 1
  for (;;) {
    const list = await cfFetch(token, `/accounts/${accountId}/d1/database?per_page=100&page=${page}`)
    const hit = list.find((d) => d.name === name)
    if (hit) return { id: hit.uuid }
    if (!list?.length || list.length < 100) return null
    page++
  }
}

/** D1：按名称查找，缺则创建；返回 { id, created } */
export async function ensureD1(token, accountId, name) {
  const hit = await findD1(token, accountId, name)
  if (hit) return { id: hit.id, created: false }
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
