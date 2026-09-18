import { Keys } from './store.js'
import type { RuntimeEnv } from './types.js'

const TABLE = 'rt_seen_events'

const SCHEMA = `CREATE TABLE IF NOT EXISTS ${TABLE} (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL
)`

let schemaReady: Promise<void> | null = null

/** 未绑定 D1 时返回 null，调用方降级到 KV */
function ensureSchema(env: RuntimeEnv): Promise<void> | null {
  const db = env.DB
  if (!db) return null
  schemaReady ??= (async () => {
    await db.exec(SCHEMA.replace(/\n\s*/g, ' '))
    await db.exec(`CREATE INDEX IF NOT EXISTS ${TABLE}_ts ON ${TABLE}(ts)`)
  })().catch((err) => {
    schemaReady = null
    throw err
  })
  return schemaReady
}

/** 测试用：清掉建表状态 */
export function resetDedupeSchema(): void {
  schemaReady = null
}

/**
 * KV 降级路径：get 后 put 不是原子的，两个并发请求可能同时判定为首次；
 * KV 本身还是最终一致，跨节点重投也可能都漏过。只在没有 D1 时用。
 */
async function claimViaKv(env: RuntimeEnv, id: string, ttlSec: number): Promise<boolean> {
  const key = Keys.event(id)
  if (await env.KV.get(key)) return false
  await env.KV.put(key, '1', { expirationTtl: Math.max(60, ttlSec) })
  return true
}

/**
 * 事件去重：首次见到返回 true 并登记。
 *
 * 有 D1 就用主键冲突做原子声明——`INSERT OR IGNORE` 在冲突时 changes 为 0，
 * 并发的两个请求只会有一个拿到 1，这是 KV 的 get-then-put 给不了的保证。
 * D1 不可用（未绑定或建表失败）时退回 KV，宁可重复处理也不能把事件丢掉。
 */
export async function claimEvent(env: RuntimeEnv, id: string, ttlSec: number): Promise<boolean> {
  const ready = ensureSchema(env)
  const db = env.DB
  if (!ready || !db) return claimViaKv(env, id, ttlSec)

  try {
    await ready
    const result = await db
      .prepare(`INSERT OR IGNORE INTO ${TABLE} (id, ts) VALUES (?, ?)`)
      .bind(id, Date.now())
      .run()
    return result.meta.changes === 1
  } catch {
    return claimViaKv(env, id, ttlSec)
  }
}

/** 删掉超过保留期的登记行；由 scheduled 调用，失败不影响定时任务本身 */
export async function pruneSeenEvents(env: RuntimeEnv, ttlSec: number): Promise<number> {
  const ready = ensureSchema(env)
  const db = env.DB
  if (!ready || !db) return 0
  await ready
  const cutoff = Date.now() - Math.max(60, ttlSec) * 1000
  const result = await db.prepare(`DELETE FROM ${TABLE} WHERE ts < ?`).bind(cutoff).run()
  return result.meta.changes ?? 0
}
