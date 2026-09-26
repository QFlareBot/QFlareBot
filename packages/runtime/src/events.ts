import type { Logger } from '@qqbot/sdk'
import type { DispatchReport } from './dispatcher.js'
import { errorInfo } from './logger.js'
import type { RuntimeEnv } from './types.js'

/**
 * 每个事件一行分发摘要，供面板概览查询；不存完整原文。
 *
 * 平时事件只进 Workers Logs（见 logs.ts），D1 一行都不写。面板点了「实时调试」才写进
 * 这里：最多 LIVE_SLOTS 条，满了覆盖最老的一条，带消息正文。
 */
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

/**
 * 旧的事件表 rt_events（一行一个事件，随机裁到 2000 条）已停写。表留着：回滚到旧版本时它还要用，
 * 表结构只增不删。
 */
const TABLE = 'rt_live_events'
/** 实时调试开关与序号，只有 id = 1 一行 */
const STATE_TABLE = 'rt_live_debug'
/** 正文最多记这么多字（实时调试记录与日志里的正文都是） */
export const CONTENT_LIMIT = 200
/** 最多留这么多条，第 n 条写进 n % LIVE_SLOTS 号格子，覆盖的一定是最老的那条 */
export const LIVE_SLOTS = 50
/** 面板每 LIVE_RENEW_MS 续一次期；续期停了（页面关掉、断网、切到后台）最多这么久就不再写 */
export const LIVE_TTL_MS = 60_000

const COLUMNS = ['id', 'ts', 'event', 'scene', 'user_id', 'target_id', 'content', 'matched', 'errors', 'outbox', 'failed'] as const

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (id INTEGER PRIMARY KEY CHECK (id = 1), until INTEGER NOT NULL, seq INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ${TABLE} (slot INTEGER PRIMARY KEY, seq INTEGER NOT NULL, id TEXT NOT NULL, ts INTEGER NOT NULL, event TEXT NOT NULL, scene TEXT NOT NULL, user_id TEXT NOT NULL, target_id TEXT NOT NULL, content TEXT NOT NULL, matched TEXT NOT NULL, errors TEXT NOT NULL, outbox INTEGER NOT NULL, failed INTEGER NOT NULL)`,
  `INSERT OR IGNORE INTO ${STATE_TABLE} (id, until, seq) VALUES (1, 0, 0)`,
]

/**
 * 开着实时调试才写：先把序号加一，再按新序号写进对应格子。两条放进同一个 batch（D1 当事务执行），
 * 并发的事件拿到的序号不会重复。没开时两条都改动 0 行，不花写入额度，也不用先单独读一次开关
 */
const BUMP_SQL = `UPDATE ${STATE_TABLE} SET seq = seq + 1 WHERE id = 1 AND until > ?`
const INSERT_SQL = `INSERT INTO ${TABLE} (slot, seq, ${COLUMNS.join(', ')}) SELECT seq % ${LIVE_SLOTS}, seq, ${COLUMNS.map(() => '?').join(', ')} FROM ${STATE_TABLE} WHERE id = 1 AND until > ? ON CONFLICT(slot) DO UPDATE SET seq = excluded.seq, ${COLUMNS.map((c) => `${c} = excluded.${c}`).join(', ')}`

let schemaReady: Promise<void> | null = null

/** 未绑定 D1 时返回 null，调用方按"没有事件记录"处理 */
function ensureSchema(env: RuntimeEnv): Promise<void> | null {
  const db = env.DB
  if (!db) return null
  schemaReady ??= (async () => {
    for (const sql of SCHEMA) await db.exec(sql)
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
    const now = Date.now()
    await env.DB.batch([
      env.DB.prepare(BUMP_SQL).bind(now),
      env.DB.prepare(INSERT_SQL).bind(
        input.id,
        now,
        input.event,
        input.scene,
        input.userId,
        input.targetId,
        input.content.slice(0, CONTENT_LIMIT),
        JSON.stringify(input.report.matched),
        JSON.stringify(input.report.errors),
        input.outbox,
        input.failed,
        now,
      ),
    ])
  } catch (err) {
    logger.warn('实时调试记录写入失败', errorInfo(err))
  }
}

/** 开启（续期）或关闭实时调试；返回写到什么时候为止，关闭时为 0 */
export async function setLiveDebug(env: RuntimeEnv, on: boolean): Promise<number | null> {
  const ready = ensureSchema(env)
  if (!ready || !env.DB) return null
  await ready
  const until = on ? Date.now() + LIVE_TTL_MS : 0
  await env.DB.prepare(`UPDATE ${STATE_TABLE} SET until = ? WHERE id = 1`).bind(until).run()
  return until
}

export async function listEvents(
  env: RuntimeEnv,
  options: { limit?: number; before?: number } = {},
): Promise<EventRecord[]> {
  const ready = ensureSchema(env)
  if (!ready || !env.DB) return []
  await ready
  const limit = Math.min(LIVE_SLOTS, Math.max(1, options.limit ?? LIVE_SLOTS))
  const fields = COLUMNS.join(', ')
  const stmt = options.before
    ? env.DB.prepare(`SELECT ${fields} FROM ${TABLE} WHERE ts < ? ORDER BY seq DESC LIMIT ?`).bind(options.before, limit)
    : env.DB.prepare(`SELECT ${fields} FROM ${TABLE} ORDER BY seq DESC LIMIT ?`).bind(limit)
  const { results } = await stmt.all<EventRecord>()
  return results
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
