/**
 * 插件数据的枚举与清理。
 *
 * 三种存储都靠命名前缀归属：KV 是 `p:<名>:`、R2 是 `p/<名>/`、D1 是表名 `p_<名>_`
 * （由 sqlScope.ts 强制）。前缀是框架**唯一**知道"哪些数据属于谁"的途径——
 * 没有它，卸载插件就只能把数据留成孤儿。
 */
import type { Logger } from '@qqbot/sdk'
import type { ContextFactory } from './context.js'
import { kvPrefix, r2Prefix } from './scoped.js'
import { errorInfo } from './logger.js'
import { listInstallNames, listManifestPlugins, listPendingCleanups } from './manifestStore.js'
import type { PluginRegistry, RegisteredPlugin } from './registry.js'
import { tablePrefix } from './sqlScope.js'
import { Keys } from './store.js'
import type { RuntimeEnv } from './types.js'

/** R2 单次 delete 的键数上限 */
const R2_DELETE_BATCH = 1000

/*
 * 一次清数据最多做多少事。Workers 一次调用里对 KV / R2 / D1 这些绑定的操作数有上限（约 1000，KV 自己也是 1000），
 * 免费版 D1 每次调用还只有 50 条查询。插件有上千个键时一口气删完会在中途抛错——钩子跑了、数据删了一半、
 * 清单还在，定时收尾每分钟再撞一次。所以每次只删一批，报出还剩多少，没删完的由调用方下次接着删
 * （卸载交给 rt_pending_cleanups，孤儿页再点一次）。
 *
 * 最坏情况的余量：KV 翻页 ≤40 次（圈邻居、自己的键）+ 删除 500 次；R2 翻页 ≤40 次（自己的对象、圈邻居的名字）
 * + 批量删除 ≤5 次；D1 读 sqlite_master 1 条 + DROP ≤20 条。合计约 610 次绑定操作、21 条 D1 查询，
 * 同一次调用里的 onUninstall 钩子、快照、账本与构建触发还剩约 390 次操作、近 30 条查询。
 */
/** 每次最多删的 KV 键数 */
const KV_PURGE_BATCH = 500
/** 每次最多删的 R2 对象数（5 次批量删除） */
const R2_PURGE_BATCH = 5 * R2_DELETE_BATCH
/** 每次最多 DROP 的表数 */
const TABLE_PURGE_BATCH = 20
/** 清数据时 KV / R2 每种列举最多翻几页（每页至多 1000 个）：列不到底就按「还有剩」处理，下一批再列 */
const PURGE_LIST_PAGES = 20

export interface StorageUsage {
  plugin: string
  kvKeys: number
  tables: { name: string; rows: number }[]
  r2Objects: number
  r2Bytes: number
}

/** 这一批删掉了多少东西，以及还剩多少 */
export interface PurgeReport {
  kvKeys: number
  tables: string[]
  r2Objects: number
  /** 因表前缀与别的插件重合而**没有**删的表——留给人工确认，宁可留孤儿也不能误删邻居 */
  skippedTables: string[]
  /** 这一批之后还没删的 KV 键。0 才算删完；键多到没列到底时是下限 */
  kvRemaining: number
  /** 同上，R2 对象 */
  r2Remaining: number
  /** 还没 DROP、下一批接着删的表（不含 skippedTables——那些是故意不删的） */
  tablesRemaining: number
}

/** 三种存储都删完了（故意跳过的表不算没删完） */
export function purgeComplete(report: PurgeReport): boolean {
  return report.kvRemaining === 0 && report.r2Remaining === 0 && report.tablesRemaining === 0
}

/** 没删完时给人看的一句「还剩什么」；删完了返回 null */
export function describeRemaining(report: PurgeReport): string | null {
  const parts = [
    report.kvRemaining > 0 ? `${report.kvRemaining} 个 KV 键` : '',
    report.r2Remaining > 0 ? `${report.r2Remaining} 个 R2 对象` : '',
    report.tablesRemaining > 0 ? `${report.tablesRemaining} 张 D1 表` : '',
  ].filter(Boolean)
  return parts.length > 0 ? `还剩 ${parts.join('、')}` : null
}

/**
 * 「已知插件名」：卸载清数据、清孤儿、卸载收尾、存储页认领表，四处共用这一份。
 *
 * D1 表名切不出归属（插件名自己可能带下划线），只能拿已知名字去匹配前缀——名单越全，越不会把别的插件
 * 留下的表当成自己的 `DROP` 掉。以前四处各拼一份，口径不一：比如 `game_stats` 卸载时保留了数据、
 * 名字又不在某一处的名单里，带清数据卸载 `game` 时 `p_game_stats_scores` 以 `p_game_` 开头，就被删了。
 *
 * 来源：线上部署里的（注册表）、D1 清单里的、账本里出现过的（DISTINCT，不受条数限制；但账本只留最近 100 条）、
 * 还在等收尾的。**不含**从 KV / R2 键名反推的名字：那要把整个前缀 list 一遍，KV list 每天也只有 1000 次，
 * 只有真要删表时才值得——purgePluginData 自己去圈（只圈可能撞表的那一段），存储页的 collectUsage
 * 本来就要把 KV / R2 列一遍，顺手并进去。
 */
export async function knownPluginNames(env: RuntimeEnv, registry: PluginRegistry): Promise<Set<string>> {
  const names = new Set(registry.all().map((p) => p.manifest.name))
  if (!env.DB) return names
  const [plugins, ledger, cleanups] = await Promise.all([
    listManifestPlugins(env.DB),
    listInstallNames(env.DB),
    listPendingCleanups(env.DB),
  ])
  for (const p of plugins) names.add(p.name)
  for (const n of ledger) names.add(n)
  for (const c of cleanups) names.add(c.name)
  return names
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

/** 列举结果；`complete` 为假表示翻到页数上限还没列到底 */
interface Listing<T> {
  items: T[]
  complete: boolean
}

async function listKvKeys(env: RuntimeEnv, prefix: string, maxPages = Infinity): Promise<Listing<string>> {
  const items: string[] = []
  let cursor: string | undefined
  let pages = 0
  do {
    const page = await env.KV.list({ prefix, ...(cursor ? { cursor } : {}) })
    for (const k of page.keys) items.push(k.name)
    cursor = page.list_complete ? undefined : page.cursor
    pages++
  } while (cursor && pages < maxPages)
  return { items, complete: !cursor }
}

async function listR2Objects(env: RuntimeEnv, prefix: string, maxPages = Infinity): Promise<Listing<{ key: string; size: number }>> {
  if (!env.R2) return { items: [], complete: true }
  const items: { key: string; size: number }[] = []
  let cursor: string | undefined
  let pages = 0
  do {
    const page = await env.R2.list({ prefix, ...(cursor ? { cursor } : {}) })
    for (const o of page.objects) items.push({ key: o.key, size: o.size })
    cursor = page.truncated ? page.cursor : undefined
    pages++
  } while (cursor && pages < maxPages)
  return { items, complete: !cursor }
}

/** R2 里以 prefix 开头的插件名：按 `/` 分组列，每个插件只占一项，不用把对象逐个列出来 */
async function listR2PluginNames(env: RuntimeEnv, prefix: string, maxPages: number): Promise<Listing<string>> {
  if (!env.R2) return { items: [], complete: true }
  const items: string[] = []
  let cursor: string | undefined
  let pages = 0
  do {
    const page = await env.R2.list({ prefix, delimiter: '/', ...(cursor ? { cursor } : {}) })
    for (const p of page.delimitedPrefixes ?? []) {
      const name = nameFromKey(p, '/')
      if (name) items.push(name)
    }
    cursor = page.truncated ? page.cursor : undefined
    pages++
  } while (cursor && pages < maxPages)
  return { items, complete: !cursor }
}

/** 从 `p:<名>:key` / `p/<名>/key` 里切出插件名——这两处分隔符明确，切得准 */
function nameFromKey(key: string, separator: string): string | null {
  const end = key.indexOf(separator, 2)
  return end > 2 ? key.slice(2, end) : null
}

/**
 * 插件名开头那一段字母数字（到第一个别的字符为止）。
 *
 * 能和 plugin 共享 D1 表的名字 o，一定满足 `tablePrefix(o)` 与 `tablePrefix(plugin)` 一个是另一个的前缀；
 * 两者都含 `_`，于是第一个 `_` 之前那段必然相同。`tablePrefix` 只把非字母数字换成 `_`，
 * 所以 o 的原名也以这一段开头——它在 KV 里的键都以 `p:<这一段>` 开头，R2 同理。
 * 圈邻居只需列这一段，不必把整个 `p:` 列一遍。
 */
function leadingSegment(plugin: string): string {
  return /^[a-zA-Z0-9]*/.exec(plugin)?.[0] ?? ''
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
    listKvKeys(env, 'p:').then((l) => l.items),
    listR2Objects(env, 'p/').then((l) => l.items),
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
 * 按前缀删掉某插件的 KV / D1 / R2 数据，**每次最多一批**（见上面的 *_PURGE_BATCH）。不碰安装清单，那是 manifestStore 的事。
 * 返回里的 `kvRemaining` / `r2Remaining` / `tablesRemaining` 说还剩多少，全为 0（`purgeComplete`）才算删完；
 * 没删完就再调一次，已删的不会重复计。
 *
 * D1 表名前缀不是单射（`my-plugin` 与 `my_plugin` 都得到 `p_my_plugin_`），也可能嵌套（`p_game_` 是
 * `p_game_stats_` 的前缀），所以任何别的已知插件的前缀也匹配某张表时，这张表就不删——`DROP TABLE` 不可逆，
 * 误删邻居比留一条孤儿严重得多。已知插件名除了传进来的 `otherPlugins`，还有从 KV / R2 键名反推的：
 * 只在真有表要删时才去列，而且只列可能撞表的那一段（见 leadingSegment）。
 */
export async function purgePluginData(
  plugin: string,
  env: RuntimeEnv,
  /** 其余已知插件名（knownPluginNames）；用来判断某张表到底是不是本插件的 */
  otherPlugins: Iterable<string> = [],
): Promise<PurgeReport> {
  const own = kvPrefix(plugin)
  const tables = await listPluginTables(env.DB, plugin)
  const others = new Set([...otherPlugins].filter((p) => p !== plugin))
  const claimedByOther = (table: string) => [...others].some((o) => table.startsWith(tablePrefix(o)))

  // 有表要删时，先从 KV / R2 键名里把可能撞表的邻居圈出来：它们也许早已卸载、名字不在任何名单里，
  // 数据却还留着。自己的 KV 键正好在同一段里，一起列出来，不多花一次 list。
  let kv: Listing<string>
  let neighboursComplete = true
  if (tables.some((t) => !claimedByOther(t))) {
    const segment = leadingSegment(plugin)
    const scan = await listKvKeys(env, `p:${segment}`, PURGE_LIST_PAGES)
    for (const key of scan.items) {
      const name = nameFromKey(key, ':')
      if (name && name !== plugin) others.add(name)
    }
    const r2Names = await listR2PluginNames(env, `p/${segment}`, PURGE_LIST_PAGES)
    for (const name of r2Names.items) if (name !== plugin) others.add(name)
    // 这一段没列到底时，自己的键列没列全也不知道——单独列一次自己的前缀。否则「还剩多少」永远是下限 1，
    // 归属未定的表就永远留到「下一批」，收尾那一行永远删不掉
    kv = scan.complete ? { items: scan.items.filter((k) => k.startsWith(own)), complete: true } : await listKvKeys(env, own, PURGE_LIST_PAGES)
    neighboursComplete = scan.complete && r2Names.complete
  } else {
    kv = await listKvKeys(env, own, PURGE_LIST_PAGES)
  }

  const kvBatch = kv.items.slice(0, KV_PURGE_BATCH)
  await Promise.all(kvBatch.map((k) => env.KV.delete(k)))
  // 没列到底：至少还有一个没列出来的
  const kvRemaining = kv.items.length - kvBatch.length + (kv.complete ? 0 : 1)

  const ambiguous = tables.filter(claimedByOther)
  const mine = tables.filter((t) => !ambiguous.includes(t))
  // 邻居没圈全（键多到没列到底）时，剩下的表归属未定，这一批不删。自己的 KV 还没删完就留到下一批——
  // 下一批要列的键少了，多半就能列到底；自己的已经删完还是列不到底，只能当作撞了邻居跳过，宁可留孤儿
  const undecided = neighboursComplete ? [] : mine
  const deferred = undecided.length > 0 && kvRemaining > 0 ? undecided : []
  const skippedTables = deferred.length > 0 ? ambiguous : [...ambiguous, ...undecided]
  const droppable = neighboursComplete ? mine : []
  const dropped = droppable.slice(0, TABLE_PURGE_BATCH)
  // 表名已按前缀过滤，只含 [A-Za-z0-9_]；DROP TABLE 会连带删掉它的索引和触发器
  for (const name of dropped) await env.DB!.exec(`DROP TABLE IF EXISTS ${name}`)

  let r2Objects = 0
  let r2Remaining = 0
  if (env.R2) {
    const listing = await listR2Objects(env, r2Prefix(plugin), PURGE_LIST_PAGES)
    const batch = listing.items.slice(0, R2_PURGE_BATCH)
    for (let i = 0; i < batch.length; i += R2_DELETE_BATCH) {
      await env.R2.delete(batch.slice(i, i + R2_DELETE_BATCH).map((o) => o.key))
    }
    r2Objects = batch.length
    r2Remaining = listing.items.length - batch.length + (listing.complete ? 0 : 1)
  }

  return {
    kvKeys: kvBatch.length,
    tables: dropped,
    r2Objects,
    skippedTables,
    kvRemaining,
    r2Remaining,
    tablesRemaining: droppable.length - dropped.length + deferred.length,
  }
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
