/**
 * 插件数据的枚举与清理。
 *
 * 三种存储都靠命名前缀归属：KV 是 `p:<名>:`、R2 是 `p/<名>/`、D1 是表名 `p_<名>_`
 * （由 sqlScope.ts 强制）。前缀是框架**唯一**知道"哪些数据属于谁"的途径——
 * 没有它，卸载插件就只能把数据留成孤儿。
 */
import type { Logger } from '@qqbot/sdk'
import { kvPrefix, r2Prefix, type ContextFactory } from './context.js'
import { errorInfo } from './logger.js'
import type { RegisteredPlugin } from './registry.js'
import { tablePrefix } from './sqlScope.js'
import { Keys } from './store.js'
import type { RuntimeEnv } from './types.js'

/** R2 单次 delete 的键数上限 */
const R2_DELETE_BATCH = 1000

export interface StorageUsage {
  plugin: string
  kvKeys: number
  tables: { name: string; rows: number }[]
  r2Objects: number
  r2Bytes: number
}

/** 删掉了多少东西 */
export interface PurgeReport {
  kvKeys: number
  tables: string[]
  r2Objects: number
  /** 因表前缀与别的插件重合而**没有**删的表——留给人工确认，宁可留孤儿也不能误删邻居 */
  skippedTables: string[]
}

/** 插件自己的 onUninstall 结果：没定义是 none，抛错是 failed（不影响后续兜底清理） */
export interface HookReport {
  hook: 'none' | 'ok' | 'failed'
  hookError?: string
}

/** 列出某插件（或全部插件）在 D1 里的表。按前缀在 JS 侧过滤——SQL 的 LIKE 会把 `_` 当通配符，`p_hello_%` 能匹配到 `p_hello2_x` */
export async function listPluginTables(db: D1Database | undefined, plugin?: string): Promise<string[]> {
  if (!db) return []
  const rows = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'p\\_%' ESCAPE '\\' ORDER BY name")
    .all<{ name: string }>()
  const names = rows.results.map((r) => r.name)
  return plugin ? names.filter((n) => n.startsWith(tablePrefix(plugin))) : names
}

/**
 * 表名 → 它属于哪个插件。`p_<名>_<表>` 里插件名自己可能带下划线，光看表名切不出分隔符，
 * 只能拿已知插件名去匹配；`my` 和 `my_plugin` 都能匹配 `p_my_plugin_notes` 时取更长的那个。
 */
export function ownerOfTable(table: string, knownPlugins: string[]): string | null {
  let best: string | null = null
  for (const p of knownPlugins) {
    if (table.startsWith(tablePrefix(p)) && (best === null || p.length > best.length)) best = p
  }
  return best
}

async function listKvKeys(env: RuntimeEnv, prefix: string): Promise<string[]> {
  const keys: string[] = []
  let cursor: string | undefined
  do {
    const page = await env.KV.list({ prefix, ...(cursor ? { cursor } : {}) })
    for (const k of page.keys) keys.push(k.name)
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  return keys
}

async function listR2Objects(env: RuntimeEnv, prefix: string): Promise<{ key: string; size: number }[]> {
  if (!env.R2) return []
  const objects: { key: string; size: number }[] = []
  let cursor: string | undefined
  do {
    const page = await env.R2.list({ prefix, ...(cursor ? { cursor } : {}) })
    for (const o of page.objects) objects.push({ key: o.key, size: o.size })
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return objects
}

/** 从 `p:<名>:key` / `p/<名>/key` 里切出插件名——这两处分隔符明确，切得准 */
function nameFromKey(key: string, separator: string): string | null {
  const end = key.indexOf(separator, 2)
  return end > 2 ? key.slice(2, end) : null
}

const emptyUsage = (plugin: string): StorageUsage => ({ plugin, kvKeys: 0, tables: [], r2Objects: 0, r2Bytes: 0 })

/**
 * 一次扫全三种存储，按插件名分桶。只读，用于 /admin/storage。
 *
 * 每种存储只列一遍而不是每个插件列一遍：候选名可能来自几百条安装账本，
 * 逐个查就是 N+1 次往返。
 *
 * @param knownPlugins D1 表名切不出归属，得拿已知名字匹配前缀；KV/R2 里反推出来的名字会自动并进来
 */
export async function collectUsage(
  env: RuntimeEnv,
  knownPlugins: string[],
): Promise<{ usage: Map<string, StorageUsage>; unattributedTables: string[] }> {
  const [kvKeys, objects, tableNames] = await Promise.all([
    listKvKeys(env, 'p:'),
    listR2Objects(env, 'p/'),
    listPluginTables(env.DB),
  ])

  const usage = new Map<string, StorageUsage>()
  const of = (plugin: string): StorageUsage => {
    let u = usage.get(plugin)
    if (!u) usage.set(plugin, (u = emptyUsage(plugin)))
    return u
  }

  for (const key of kvKeys) {
    const name = nameFromKey(key, ':')
    if (name) of(name).kvKeys += 1
  }
  for (const o of objects) {
    const name = nameFromKey(o.key, '/')
    if (!name) continue
    const u = of(name)
    u.r2Objects += 1
    u.r2Bytes += o.size
  }

  // KV/R2 里反推出的名字也是可信候选，一并拿去认领表
  const candidates = [...new Set([...knownPlugins, ...usage.keys()])]
  const unattributedTables: string[] = []
  for (const table of tableNames) {
    const owner = ownerOfTable(table, candidates)
    if (!owner) {
      unattributedTables.push(table)
      continue
    }
    // 表名来自 sqlite_master 且已按前缀过滤，只含 [A-Za-z0-9_]，拼进 SQL 是安全的
    const row = await env.DB!.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>()
    of(owner).tables.push({ name: table, rows: row?.n ?? 0 })
  }

  for (const plugin of knownPlugins) of(plugin)
  return { usage, unattributedTables }
}

/**
 * 先给插件自己一次清理机会（它可能有前缀之外的东西要收尾），再由框架按前缀兜底。
 * 钩子抛错不影响兜底——插件写坏了不该导致数据永远清不掉。
 */
export async function runUninstallHook(
  plugin: RegisteredPlugin,
  contexts: ContextFactory,
  purgeData: boolean,
  logger: Logger,
): Promise<HookReport> {
  let def
  try {
    def = await plugin.load()
  } catch {
    return { hook: 'failed', hookError: '插件代码加载失败' }
  }
  if (!def?.hooks?.onUninstall) return { hook: 'none' }
  try {
    await def.hooks.onUninstall(await contexts.prepare(plugin), { purgeData })
    return { hook: 'ok' }
  } catch (err) {
    logger.error('插件 onUninstall 失败，继续按前缀兜底清理', { plugin: plugin.manifest.name, ...errorInfo(err) })
    return { hook: 'failed', hookError: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 按前缀删掉某插件的全部 KV / D1 / R2 数据。不碰安装清单，那是 manifestStore 的事。
 *
 * D1 表名前缀不是单射（`my-plugin` 与 `my_plugin` 都得到 `p_my_plugin_`），所以传进来的
 * `otherPlugins` 里任何一个也匹配某张表时，这张表就不删——`DROP TABLE` 不可逆，
 * 误删邻居比留一条孤儿严重得多。
 */
export async function purgePluginData(
  plugin: string,
  env: RuntimeEnv,
  /** 其余已知插件名（已装 + 账本里出现过的）；用来判断某张表到底是不是本插件的 */
  otherPlugins: readonly string[] = [],
): Promise<PurgeReport> {
  const [kvKeys, tables, objects] = await Promise.all([
    listKvKeys(env, kvPrefix(plugin)),
    listPluginTables(env.DB, plugin),
    listR2Objects(env, r2Prefix(plugin)),
  ])

  const others = otherPlugins.filter((p) => p !== plugin)
  const ambiguous = tables.filter((t) => others.some((o) => t.startsWith(tablePrefix(o))))
  const mine = tables.filter((t) => !ambiguous.includes(t))

  await Promise.all(kvKeys.map((k) => env.KV.delete(k)))

  // 表名已按前缀过滤，只含 [A-Za-z0-9_]；DROP TABLE 会连带删掉它的索引和触发器
  for (const name of mine) await env.DB!.exec(`DROP TABLE IF EXISTS ${name}`)

  if (env.R2) {
    for (let i = 0; i < objects.length; i += R2_DELETE_BATCH) {
      await env.R2.delete(objects.slice(i, i + R2_DELETE_BATCH).map((o) => o.key))
    }
  }

  return { kvKeys: kvKeys.length, tables: mine, r2Objects: objects.length, skippedTables: ambiguous }
}

/**
 * 卸载时清掉 onInstall 的"已装过"标记。
 *
 * 不管保不保留数据都要删：数据清了，重装必须重新建表；数据留着，onInstall
 * 本来就要求幂等，重跑一次也无害。留着标记的后果是重装后 onInstall 静默不跑。
 */
export async function clearInstallMarker(plugin: string, env: RuntimeEnv): Promise<void> {
  await env.KV.delete(Keys.installed(plugin))
}
