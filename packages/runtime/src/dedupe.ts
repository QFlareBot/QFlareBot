import { Keys } from './store.js'
import type { RuntimeEnv } from './types.js'

/**
 * 去重登记表：固定 65536 个格子，事件 id 哈希到格子上，新事件直接覆盖格子里的旧 id。
 *
 * D1 按改动的行数计费，删除也算写入。以前一行一个事件、定时删过期行，每个事件要付
 * 插入 + 删除（各带一次 ts 索引）四行写入；覆盖格子只要一行，也不用再清理。
 * 代价是两个事件撞上同一个格子时，前一个的重投会被当成新事件再处理一次——只会重复、
 * 不会丢，和降级到 KV 时的取舍一致。QQ 的重投在几分钟内，撞格子的机会很小。
 *
 * 格子数不要改：改了哈希落点全变，已登记的 id 会被当成新事件（同样只是重复处理一次）。
 */
const TABLE = 'rt_seen_ring'
const SLOTS = 65536

/** 旧的去重表：一行一个事件，靠定时删过期行。停写后只剩最后几分钟的登记，清完为止 */
const LEGACY_TABLE = 'rt_seen_events'

const SCHEMA = `CREATE TABLE IF NOT EXISTS ${TABLE} (slot INTEGER PRIMARY KEY, id TEXT NOT NULL)`

/**
 * 首次见到的 id 插入或覆盖格子（改动 1 行）；格子里已经是它就什么都不改（改动 0 行）。
 * 一条语句完成判断与登记，并发的两个请求只有一个拿到 1，和以前的主键冲突一样是原子的
 */
const CLAIM_SQL = `INSERT INTO ${TABLE} (slot, id) VALUES (?, ?) ON CONFLICT(slot) DO UPDATE SET id = excluded.id WHERE ${TABLE}.id != excluded.id`

let schemaReady: Promise<void> | null = null
let legacyPruned = false

/** 未绑定 D1 时返回 null，调用方降级到 KV */
function ensureSchema(env: RuntimeEnv): Promise<void> | null {
  const db = env.DB
  if (!db) return null
  schemaReady ??= db.exec(SCHEMA).then(
    () => undefined,
    (err: unknown) => {
      schemaReady = null
      throw err
    },
  )
  return schemaReady
}

/** 测试用：清掉建表状态 */
export function resetDedupeSchema(): void {
  schemaReady = null
  legacyPruned = false
}

/** FNV-1a 32 位，按 UTF-16 码元算；只要求稳定、分布均匀 */
export function dedupeSlot(id: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % SLOTS
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
 * 有 D1 就走格子覆盖（见 CLAIM_SQL），D1 不可用（未绑定或建表失败）时退回 KV，
 * 宁可重复处理也不能把事件丢掉。`ttlSec` 只对 KV 降级有意义：格子没有过期，只会被覆盖。
 */
export async function claimEvent(env: RuntimeEnv, id: string, ttlSec: number): Promise<boolean> {
  const ready = ensureSchema(env)
  const db = env.DB
  if (!ready || !db) return claimViaKv(env, id, ttlSec)

  try {
    await ready
    const result = await db.prepare(CLAIM_SQL).bind(dedupeSlot(id), id).run()
    return result.meta.changes === 1
  } catch {
    return claimViaKv(env, id, ttlSec)
  }
}

/**
 * 清旧去重表里过期的行；由 scheduled 调用，失败不影响定时任务本身。
 *
 * 新代码不再写这张表，删到一行不剩（或表根本不存在）之后这个 isolate 就不再查。
 * 表本身留着：回滚到旧版本时它还要用，表结构只增不删。
 */
export async function pruneSeenEvents(env: RuntimeEnv, ttlSec: number): Promise<number> {
  const db = env.DB
  if (!db || legacyPruned) return 0
  const cutoff = Date.now() - Math.max(60, ttlSec) * 1000
  try {
    const result = await db.prepare(`DELETE FROM ${LEGACY_TABLE} WHERE ts < ?`).bind(cutoff).run()
    const removed = result.meta.changes ?? 0
    if (removed === 0) {
      const left = await db.prepare(`SELECT COUNT(*) AS n FROM ${LEGACY_TABLE}`).first<{ n: number }>()
      if (!left?.n) legacyPruned = true
    }
    return removed
  } catch (err) {
    // 新部署从没建过这张表
    if (String(err).includes('no such table')) {
      legacyPruned = true
      return 0
    }
    throw err
  }
}
