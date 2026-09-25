/** 清单存储与安装账本：D1 表 + 纯函数（哈希、源码解析） */
import type { Manifest } from '@qqbot/sdk'

const TABLE_PLUGINS = 'rt_manifest_plugins'
const TABLE_INSTALLS = 'rt_installs'
const TABLE_CLEANUPS = 'rt_pending_cleanups'

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ${TABLE_PLUGINS} (
    name TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    source TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ${TABLE_INSTALLS} (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    name TEXT,
    source TEXT,
    manifest_hash TEXT NOT NULL,
    build_uuid TEXT,
    cf_status TEXT,
    status TEXT NOT NULL,
    commit_hash TEXT,
    error TEXT,
    ts INTEGER NOT NULL
  )`,
  // 卸载的后半段：等插件真的不在部署里了再收尾（见 adminManifest.ts 的 processPendingCleanups）
  `CREATE TABLE IF NOT EXISTS ${TABLE_CLEANUPS} (
    name TEXT PRIMARY KEY,
    purge INTEGER NOT NULL,
    ts INTEGER NOT NULL
  )`,
]

/**
 * 插件表后加的列。已有的库里 CREATE TABLE IF NOT EXISTS 什么都不做，只能看 PRAGMA table_info 补上；
 * 列都可空、不带约束，ALTER TABLE ADD COLUMN 在有数据的表上也能直接加，老记录读出来是 NULL。
 */
const ADDED_PLUGIN_COLUMNS: ReadonlyArray<readonly [name: string, type: string]> = [
  /** 安装时读到的声明清单（JSON）。反向依赖、冲突、DO 类比对都靠它；这一列加上之前装的记录为 NULL */
  ['manifest', 'TEXT'],
  /** 构建机回报的构建错误，只对当前 source 有效：换 source 即清空 */
  ['build_error', 'TEXT'],
]

async function migratePluginColumns(db: D1Database): Promise<void> {
  const { results } = await db.prepare(`PRAGMA table_info(${TABLE_PLUGINS})`).all<{ name: string }>()
  const have = new Set(results.map((r) => r.name))
  for (const [column, type] of ADDED_PLUGIN_COLUMNS) {
    if (have.has(column)) continue
    try {
      await db.exec(`ALTER TABLE ${TABLE_PLUGINS} ADD COLUMN ${column} ${type}`)
    } catch (err) {
      // 两个 isolate 同时冷启动会一起补同一列，后到的那个撞 duplicate column——列已经在了，不算失败
      if (!/duplicate column/i.test(err instanceof Error ? err.message : String(err))) throw err
    }
  }
}

let schemaReady: Promise<void> | null = null

function ensureSchema(db: D1Database): Promise<void> {
  schemaReady ??= (async () => {
    for (const stmt of SCHEMA) await db.exec(stmt.replace(/\n\s*/g, ' '))
    await migratePluginColumns(db)
  })().catch((err) => {
    schemaReady = null
    throw err
  })
  return schemaReady
}

/** 测试用：清掉建表状态 */
export function resetManifestSchema(): void {
  schemaReady = null
}

/** D1 里记录的插件条目：构建机据此拉源码编译 */
export interface ManifestPluginEntry {
  name: string
  version: string
  source: string
}

/** D1 清单条目的完整形态。管理端点用；构建机只要 ManifestPluginEntry 那三个字段 */
export interface ManifestPluginRecord extends ManifestPluginEntry {
  /** 安装时读到的声明清单；这个字段加入之前装的记录为 null */
  manifest: Manifest | null
  /** 构建机回报的构建错误，只对当前 source 有效 */
  buildError: string | null
  addedAt: number
  updatedAt: number
}

/** 安装/构建账本的一行 */
export interface InstallRecord {
  id: string
  action: 'install' | 'upgrade' | 'uninstall' | 'build'
  name: string | null
  source: string | null
  manifestHash: string
  buildUuid: string | null
  cfStatus: string | null
  status: 'pending' | 'building' | 'ok' | 'failed'
  commitHash: string | null
  error: string | null
  ts: number
}

// ---------- 源码格式 ----------

const GIT_SOURCE = /^git:([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9._-]+)@([0-9a-f]{7,40})(?:#([^#\s]+))?$/

export interface GitSource {
  owner: string
  repo: string
  sha: string
  subdir?: string
}

/** 解析源码来源 `git:<owner>/<repo>@<commit>[#<子目录>]`；commit 至少 7 位 hex */
export function parseGitSource(source: string): GitSource | null {
  const m = GIT_SOURCE.exec(source.trim())
  if (!m) return null
  const [, owner, repo, sha, subdir] = m
  if (subdir && (subdir.startsWith('/') || subdir.includes('..'))) return null
  return { owner: owner!, repo: repo!, sha: sha!, ...(subdir ? { subdir } : {}) }
}

/** 同一个插件仓库（owner/repo 加子目录），不看 commit：用来判断一次安装是「升级」还是「换了别家的代码」 */
export function sameGitRepo(a: GitSource, b: GitSource): boolean {
  return a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase() && (a.subdir ?? '') === (b.subdir ?? '')
}

/** 声明清单（manifest.json）在源码仓库里的 raw 地址；dist/ 里的旧位置兜底一份 */
export function rawManifestUrl(git: GitSource, dist = false): string {
  const dir = git.subdir ? `${git.subdir}/${dist ? 'dist/' : ''}` : dist ? 'dist/' : ''
  return `https://raw.githubusercontent.com/${git.owner}/${git.repo}/${git.sha}/${dir}manifest.json`
}

/** 插件目录里其他文件（package.json、lockfile）的 raw 地址，与声明清单同一目录 */
export function rawPluginFileUrl(git: GitSource, file: string): string {
  const dir = git.subdir ? `${git.subdir}/` : ''
  return `https://raw.githubusercontent.com/${git.owner}/${git.repo}/${git.sha}/${dir}${file}`
}

// ---------- 哈希（纯函数） ----------

/**
 * 插件集哈希：对 [name, version, source] 三元组按名排序后 JSON 序列化取 sha256。
 * 触发构建时写入账本，构建机拿到的清单哈希与之对照，即可发现"构建的清单"与"触发的清单"是否一致。
 */
export async function manifestHash(plugins: readonly ManifestPluginEntry[]): Promise<string> {
  const canonical = JSON.stringify(
    [...plugins].map((p) => [p.name, p.version, p.source]).sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0)),
  )
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ---------- 存储 ----------

function rowToEntry(row: Record<string, unknown>): ManifestPluginEntry {
  return { name: row.name as string, version: row.version as string, source: row.source as string }
}

/** manifest 列是 JSON 文本；坏掉或缺 name 的当作没有，别让一条脏数据拖垮整个列表 */
function parseManifestColumn(value: unknown): Manifest | null {
  if (typeof value !== 'string' || value === '') return null
  try {
    const parsed = JSON.parse(value) as unknown
    return typeof parsed === 'object' && parsed !== null && typeof (parsed as { name?: unknown }).name === 'string'
      ? (parsed as Manifest)
      : null
  } catch {
    return null
  }
}

function rowToRecord(row: Record<string, unknown>): ManifestPluginRecord {
  return {
    ...rowToEntry(row),
    manifest: parseManifestColumn(row.manifest),
    buildError: typeof row.build_error === 'string' ? row.build_error : null,
    addedAt: typeof row.added_at === 'number' ? row.added_at : 0,
    updatedAt: typeof row.updated_at === 'number' ? row.updated_at : 0,
  }
}

function rowToInstall(row: Record<string, unknown>): InstallRecord {
  return {
    id: row.id as string,
    action: row.action as InstallRecord['action'],
    name: (row.name as string | null) ?? null,
    source: (row.source as string | null) ?? null,
    manifestHash: row.manifest_hash as string,
    buildUuid: (row.build_uuid as string | null) ?? null,
    cfStatus: (row.cf_status as string | null) ?? null,
    status: row.status as InstallRecord['status'],
    commitHash: (row.commit_hash as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    ts: row.ts as number,
  }
}

export async function listManifestPlugins(db: D1Database): Promise<ManifestPluginEntry[]> {
  await ensureSchema(db)
  const { results } = await db
    .prepare(`SELECT name, version, source FROM ${TABLE_PLUGINS} ORDER BY name`)
    .all<Record<string, unknown>>()
  return results.map(rowToEntry)
}

/** 带声明清单与构建错误的完整条目，按名排序 */
export async function listManifestPluginRecords(db: D1Database): Promise<ManifestPluginRecord[]> {
  await ensureSchema(db)
  const { results } = await db
    .prepare(`SELECT name, version, source, manifest, build_error, added_at, updated_at FROM ${TABLE_PLUGINS} ORDER BY name`)
    .all<Record<string, unknown>>()
  return results.map(rowToRecord)
}

async function getPluginRow(db: D1Database, name: string): Promise<Record<string, unknown> | null> {
  await ensureSchema(db)
  return db
    .prepare(`SELECT name, version, source, added_at FROM ${TABLE_PLUGINS} WHERE name = ?`)
    .bind(name)
    .first<Record<string, unknown>>()
}

export async function getManifestPlugin(db: D1Database, name: string): Promise<ManifestPluginEntry | null> {
  const row = await getPluginRow(db, name)
  return row ? rowToEntry(row) : null
}

/**
 * 写入（或覆盖）一个插件条目。带上 `manifest` 就连声明清单一起存；
 * 构建错误总是清空——它只对旧 source 有效，新 source 还没构建过。
 */
export async function upsertManifestPlugin(
  db: D1Database,
  entry: ManifestPluginEntry & { manifest?: Manifest | null },
  now = Date.now(),
): Promise<void> {
  await ensureSchema(db)
  const existing = await getPluginRow(db, entry.name)
  const addedAt = typeof existing?.added_at === 'number' ? existing.added_at : now
  await db
    .prepare(
      `INSERT OR REPLACE INTO ${TABLE_PLUGINS} (name, version, source, manifest, build_error, added_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    )
    .bind(entry.name, entry.version, entry.source, entry.manifest ? JSON.stringify(entry.manifest) : null, addedAt, now)
    .run()
}

export async function deleteManifestPlugin(db: D1Database, name: string): Promise<void> {
  await ensureSchema(db)
  await db.prepare(`DELETE FROM ${TABLE_PLUGINS} WHERE name = ?`).bind(name).run()
}

/** 记下构建机回报的构建错误。只在 D1 里还是报告里那个 source 时才记——用户可能已经换了版本 */
export async function setPluginBuildError(db: D1Database, name: string, source: string, message: string): Promise<void> {
  await ensureSchema(db)
  await db.prepare(`UPDATE ${TABLE_PLUGINS} SET build_error = ? WHERE name = ? AND source = ?`).bind(message, name, source).run()
}

/**
 * 有一次构建成功了，就把所有构建错误清掉：构建机每次都拉完整清单，成功意味着当时清单里的每个插件都编过了；
 * 之后才改过的条目在 upsert 时本来就清了。
 */
export async function clearPluginBuildErrors(db: D1Database): Promise<void> {
  await ensureSchema(db)
  await db.prepare(`UPDATE ${TABLE_PLUGINS} SET build_error = NULL WHERE build_error IS NOT NULL`).run()
}

export interface NewInstall {
  action: InstallRecord['action']
  name: string | null
  source: string | null
  manifestHash: string
  status: InstallRecord['status']
  buildUuid?: string | null
  error?: string | null
}

/** 账本保留条数：账本是排障用的近期流水，不是审计日志，超出即清 */
const INSTALL_RETENTION = 100

export async function insertInstall(db: D1Database, input: NewInstall, now = Date.now()): Promise<InstallRecord> {
  await ensureSchema(db)
  const record: InstallRecord = {
    id: crypto.randomUUID(),
    action: input.action,
    name: input.name,
    source: input.source,
    manifestHash: input.manifestHash,
    buildUuid: input.buildUuid ?? null,
    cfStatus: null,
    status: input.status,
    commitHash: null,
    error: input.error ?? null,
    ts: now,
  }
  await db
    .prepare(
      `INSERT INTO ${TABLE_INSTALLS} (id, action, name, source, manifest_hash, build_uuid, cf_status, status, commit_hash, error, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(record.id, record.action, record.name, record.source, record.manifestHash, record.buildUuid, record.cfStatus, record.status, record.commitHash, record.error, record.ts)
    .run()
  // 顺带把超出保留条数的旧记录清掉；清理失败不影响安装本身（下次写入会再试）
  await db
    .prepare(
      `DELETE FROM ${TABLE_INSTALLS} WHERE id NOT IN (SELECT id FROM ${TABLE_INSTALLS} ORDER BY ts DESC LIMIT ${INSTALL_RETENTION})`,
    )
    .run()
    .catch(() => {})
  return record
}

/** 按 id 更新一条账本记录（用于没有 build_uuid 的卡死记录收敛） */
export async function updateInstallById(
  db: D1Database,
  id: string,
  patch: { status: InstallRecord['status']; error?: string | null },
): Promise<void> {
  await ensureSchema(db)
  await db.prepare(`UPDATE ${TABLE_INSTALLS} SET status = ?, error = ? WHERE id = ?`).bind(patch.status, patch.error ?? null, id).run()
}

/**
 * 触发构建后，把所有 pending 记录并入这次构建。
 *
 * 不按清单哈希筛：构建机在构建那一刻拉的是**最新**清单，触发之前写下的每一条改动都在里面。
 * 以前按哈希精确匹配，一次写好几条（批量更新）时每条记录存的是写它那一刻的哈希，
 * 只有最后一条对得上，前面几条会一直 pending，24 小时后被收敛成「失败」——其实早就上线了。
 */
export async function markPendingBuilding(db: D1Database, buildUuid: string): Promise<void> {
  await ensureSchema(db)
  await db.prepare(`UPDATE ${TABLE_INSTALLS} SET status = 'building', build_uuid = ? WHERE status = 'pending'`).bind(buildUuid).run()
}

/** 清单改完已经和线上部署一致（撤销了还没上线的改动），pending 记录不用等构建，直接算完成 */
export async function settlePendingInstalls(db: D1Database): Promise<void> {
  await ensureSchema(db)
  await db.prepare(`UPDATE ${TABLE_INSTALLS} SET status = 'ok' WHERE status = 'pending'`).run()
}

/**
 * 按 build_uuid 同步状态。错误信息只补不盖：构建机回报的具体原因（哪个插件、为什么）先到，
 * 之后 Builds API 同步过来的只是一句「构建未成功：fail」，不能把前者冲掉。
 */
export async function updateInstallByBuildUuid(
  db: D1Database,
  buildUuid: string,
  patch: { status: InstallRecord['status']; cfStatus?: string | null; commitHash?: string | null; error?: string | null },
): Promise<void> {
  await ensureSchema(db)
  await db
    .prepare(`UPDATE ${TABLE_INSTALLS} SET status = ?, cf_status = ?, commit_hash = ?, error = COALESCE(error, ?) WHERE build_uuid = ?`)
    .bind(patch.status, patch.cfStatus ?? null, patch.commitHash ?? null, patch.error ?? null, buildUuid)
    .run()
}

/** 构建机回报的失败原因记到这次构建的全部账本记录上（已有错误的不覆盖） */
export async function attachBuildError(db: D1Database, buildUuid: string, message: string): Promise<void> {
  await ensureSchema(db)
  await db.prepare(`UPDATE ${TABLE_INSTALLS} SET error = COALESCE(error, ?) WHERE build_uuid = ?`).bind(message, buildUuid).run()
}

export async function listInstalls(db: D1Database, limit = 50): Promise<InstallRecord[]> {
  await ensureSchema(db)
  const { results } = await db
    .prepare(
      `SELECT id, action, name, source, manifest_hash, build_uuid, cf_status, status, commit_hash, error, ts
       FROM ${TABLE_INSTALLS} ORDER BY ts DESC LIMIT ?`,
    )
    .bind(Math.min(200, Math.max(1, limit)))
    .all<Record<string, unknown>>()
  return results.map(rowToInstall)
}

// ---------- 卸载的后半段 ----------

export interface PendingCleanup {
  name: string
  /** 卸载时选了连数据一起清 */
  purge: boolean
  ts: number
}

/** 卸载时记一条：等插件不在部署里了，再删一遍 onInstall 标记、按需再清一遍数据 */
export async function addPendingCleanup(db: D1Database, name: string, purge: boolean, now = Date.now()): Promise<void> {
  await ensureSchema(db)
  await db.prepare(`INSERT OR REPLACE INTO ${TABLE_CLEANUPS} (name, purge, ts) VALUES (?, ?, ?)`).bind(name, purge ? 1 : 0, now).run()
}

export async function removePendingCleanup(db: D1Database, name: string): Promise<void> {
  await ensureSchema(db)
  await db.prepare(`DELETE FROM ${TABLE_CLEANUPS} WHERE name = ?`).bind(name).run()
}

export async function listPendingCleanups(db: D1Database): Promise<PendingCleanup[]> {
  await ensureSchema(db)
  const { results } = await db.prepare(`SELECT name, purge, ts FROM ${TABLE_CLEANUPS} ORDER BY ts`).all<Record<string, unknown>>()
  return results.map((r) => ({ name: r.name as string, purge: r.purge === 1 || r.purge === true, ts: r.ts as number }))
}
