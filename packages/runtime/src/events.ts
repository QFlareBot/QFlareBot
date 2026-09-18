import type { Logger } from '@qqbot/sdk'
import type { DispatchReport } from './dispatcher.js'
import { errorInfo } from './logger.js'
import type { RuntimeEnv } from './types.js'

/** 每个事件一行分发摘要，供面板概览与调试页查询；不存完整原文 */
export interface EventRecord {
  id: string
  ts: number
  event: string
  scene: string
  user_id: string
  target_id: string
  content: string
  matched: string
  errors: string
  outbox: number
  /** 发送失败（接口返回非 2xx 或凭证问题）的消息数 */
  failed: number
}

const TABLE = 'rt_events'
const CONTENT_LIMIT = 200
const MAX_ROWS = 2000

const SCHEMA = `CREATE TABLE IF NOT EXISTS ${TABLE} (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  event TEXT NOT NULL,
  scene TEXT NOT NULL,
  user_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  content TEXT NOT NULL,
  matched TEXT NOT NULL,
  errors TEXT NOT NULL,
  outbox INTEGER NOT NULL,
  failed INTEGER NOT NULL DEFAULT 0
)`

/** 后加的列：CREATE TABLE IF NOT EXISTS 不会补列，这里逐个尝试 ADD COLUMN，已存在则忽略 */
const ADDED_COLUMNS = ['failed INTEGER NOT NULL DEFAULT 0']

let schemaReady: Promise<void> | null = null

/** 未绑定 D1 时返回 null，调用方按"没有事件记录"处理 */
function ensureSchema(env: RuntimeEnv): Promise<void> | null {
  const db = env.DB
  if (!db) return null
  schemaReady ??= (async () => {
    await db.exec(SCHEMA.replace(/\n\s*/g, ' '))
    await db.exec(`CREATE INDEX IF NOT EXISTS ${TABLE}_ts ON ${TABLE}(ts DESC)`)
    for (const column of ADDED_COLUMNS) {
      await db.exec(`ALTER TABLE ${TABLE} ADD COLUMN ${column}`).catch((err: unknown) => {
        if (!String(err).includes('duplicate column')) throw err
      })
    }
  })().catch((err) => {
    schemaReady = null
    throw err
  })
  return schemaReady
}

export interface RecordInput {
  id: string
  event: string
  scene: string
  userId: string
  targetId: string
  content: string
  report: DispatchReport
  outbox: number
  failed: number
}

/** 写入失败只记日志，绝不影响事件处理 */
export async function recordEvent(env: RuntimeEnv, input: RecordInput, logger: Logger): Promise<void> {
  const ready = ensureSchema(env)
  if (!ready || !env.DB) return
  try {
    await ready
    await env.DB.prepare(
      `INSERT OR REPLACE INTO ${TABLE} (id, ts, event, scene, user_id, target_id, content, matched, errors, outbox, failed) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(
        input.id,
        Date.now(),
        input.event,
        input.scene,
        input.userId,
        input.targetId,
        input.content.slice(0, CONTENT_LIMIT),
        JSON.stringify(input.report.matched),
        JSON.stringify(input.report.errors),
        input.outbox,
        input.failed,
      )
      .run()
    // 1% 概率顺手裁掉最老的记录，避免表无限增长
    if (Math.random() < 0.01) {
      await env.DB.prepare(
        `DELETE FROM ${TABLE} WHERE id IN (SELECT id FROM ${TABLE} ORDER BY ts DESC LIMIT -1 OFFSET ?)`,
      )
        .bind(MAX_ROWS)
        .run()
    }
  } catch (err) {
    logger.warn('事件记录写入失败', errorInfo(err))
  }
}

export async function listEvents(
  env: RuntimeEnv,
  options: { limit?: number; before?: number } = {},
): Promise<EventRecord[]> {
  const ready = ensureSchema(env)
  if (!ready || !env.DB) return []
  await ready
  const limit = Math.min(200, Math.max(1, options.limit ?? 50))
  const stmt = options.before
    ? env.DB.prepare(`SELECT * FROM ${TABLE} WHERE ts < ? ORDER BY ts DESC LIMIT ?`).bind(options.before, limit)
    : env.DB.prepare(`SELECT * FROM ${TABLE} ORDER BY ts DESC LIMIT ?`).bind(limit)
  const { results } = await stmt.all<EventRecord>()
  return results
}

export async function eventStats(env: RuntimeEnv): Promise<{ total: number; last24h: number; errors24h: number } | null> {
  const ready = ensureSchema(env)
  if (!ready || !env.DB) return null
  await ready
  const since = Date.now() - 24 * 3600 * 1000
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END) AS last24h,
            SUM(CASE WHEN ts >= ? AND (errors != '[]' OR failed > 0) THEN 1 ELSE 0 END) AS errors24h
     FROM ${TABLE}`,
  )
    .bind(since, since)
    .first<{ total: number; last24h: number | null; errors24h: number | null }>()
  return { total: row?.total ?? 0, last24h: row?.last24h ?? 0, errors24h: row?.errors24h ?? 0 }
}

export async function clearEvents(env: RuntimeEnv): Promise<void> {
  const ready = ensureSchema(env)
  if (!ready || !env.DB) return
  await ready
  await env.DB.exec(`DELETE FROM ${TABLE}`)
}

/** 测试用 */
export function resetEventsSchema(): void {
  schemaReady = null
}
