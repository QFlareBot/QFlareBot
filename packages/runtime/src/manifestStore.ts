/** 清单存储与安装账本：两张 D1 表 + 纯函数（合并、哈希、源码解析） */

const TABLE_PLUGINS = 'rt_manifest_plugins'
const TABLE_INSTALLS = 'rt_installs'

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
]

let schemaReady: Promise<void> | null = null

function ensureSchema(db: D1Database): Promise<void> {
  schemaReady ??= (async () => {
    for (const stmt of SCHEMA) await db.exec(stmt.replace(/\n\s*/g, ' '))
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

/** 声明清单（manifest.json）在源码仓库里的 raw 地址；dist/ 里的旧位置兜底一份 */
export function rawManifestUrl(git: GitSource, dist = false): string {
  const dir = git.subdir ? `${git.subdir}/${dist ? 'dist/' : ''}` : dist ? 'dist/' : ''
  return `https://raw.githubusercontent.com/${git.owner}/${git.repo}/${git.sha}/${dir}manifest.json`
}

// ---------- 合并与哈希（纯函数） ----------

/**
 * 合并仓库内置插件与 D1 已装插件：同名时 D1 覆盖（可下架内置插件），
 * D1 独有的按名排序追加在后。
 */
export function mergeManifestPlugins<T extends { name: string }>(base: readonly T[], overrides: readonly T[]): T[] {
  const byName = new Map(overrides.map((p) => [p.name, p]))
  const out: T[] = base.map((p) => byName.get(p.name) ?? p)
  const seen = new Set(base.map((p) => p.name))
  const extra = overrides
    .filter((p) => !seen.has(p.name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return [...out, ...extra]
}

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

export async function upsertManifestPlugin(db: D1Database, entry: ManifestPluginEntry, now = Date.now()): Promise<void> {
  await ensureSchema(db)
  const existing = await getPluginRow(db, entry.name)
  const addedAt = typeof existing?.added_at === 'number' ? existing.added_at : now
  await db
    .prepare(`INSERT OR REPLACE INTO ${TABLE_PLUGINS} (name, version, source, added_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(entry.name, entry.version, entry.source, addedAt, now)
    .run()
}

export async function deleteManifestPlugin(db: D1Database, name: string): Promise<void> {
  await ensureSchema(db)
  await db.prepare(`DELETE FROM ${TABLE_PLUGINS} WHERE name = ?`).bind(name).run()
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
  return record
}

/** 触发构建后，把同哈希的 pending 安装记录并入这次构建 */
export async function markPendingBuilding(db: D1Database, hash: string, buildUuid: string): Promise<void> {
  await ensureSchema(db)
  await db
    .prepare(`UPDATE ${TABLE_INSTALLS} SET status = 'building', build_uuid = ? WHERE status = 'pending' AND manifest_hash = ?`)
    .bind(buildUuid, hash)
    .run()
}

export async function updateInstallByBuildUuid(
  db: D1Database,
  buildUuid: string,
  patch: { status: InstallRecord['status']; cfStatus?: string | null; commitHash?: string | null; error?: string | null },
): Promise<void> {
  await ensureSchema(db)
  await db
    .prepare(`UPDATE ${TABLE_INSTALLS} SET status = ?, cf_status = ?, commit_hash = ?, error = ? WHERE build_uuid = ?`)
    .bind(patch.status, patch.cfStatus ?? null, patch.commitHash ?? null, patch.error ?? null, buildUuid)
    .run()
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
