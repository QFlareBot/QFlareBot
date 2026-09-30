import type { SendResult, SendTarget } from '@qqbot/sdk'

/** 平台只允许撤回 2 分钟内的消息，多留 1 分钟余量 */
const TTL_MS = 3 * 60_000
/** 条数上限：一条约几百字节，满了先丢最早的 */
const MAX_ENTRIES = 5000

/**
 * ref index → 消息 id 的对照表，只在内存里，不写任何存储。
 *
 * 群、单聊里引用别的消息时，推送只带被引用那条的 ref index（message_scene.ext 的 ref_msg_idx），没有消息 id，
 * 平台也没有按 ref index 查消息的接口；撤回却要消息 id。所以收到消息、发出消息时各记一条，
 * 收到引用消息时拿 ref_msg_idx 来查，补上 session.quote.messageId。
 * 只查得到同一个 isolate 里见过的消息，查不到就还是空串。
 */
export class RefIndexTable {
  /** 键带上会话目标，免得不同群的 ref index 撞上；Map 按插入先后排，最早的在前 */
  private readonly entries = new Map<string, { messageId: string; expires: number }>()

  remember(target: SendTarget, refIndex: string | undefined, messageId: string | undefined, now = Date.now()): void {
    if (!target.id || !refIndex || !messageId) return
    const key = keyOf(target, refIndex)
    this.entries.delete(key)
    this.entries.set(key, { messageId, expires: now + TTL_MS })
    // 所有条目存活时长相同，过期的一定排在最前面
    for (const [k, v] of this.entries) {
      if (v.expires > now && this.entries.size <= MAX_ENTRIES) break
      this.entries.delete(k)
    }
  }

  /** 机器人发出的消息：结果里带 ref index 和消息 id 才记 */
  rememberSent(target: SendTarget, result: SendResult, now = Date.now()): void {
    if (result.ok) this.remember(target, result.refIndex, result.messageId, now)
  }

  lookup(target: SendTarget, refIndex: string, now = Date.now()): string | undefined {
    const key = keyOf(target, refIndex)
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expires <= now) {
      this.entries.delete(key)
      return undefined
    }
    return entry.messageId
  }

  get size(): number {
    return this.entries.size
  }
}

function keyOf(target: SendTarget, refIndex: string): string {
  return `${target.scene}:${target.id}:${refIndex}`
}

/** 整个 isolate 共用一份：一个 Worker 只服务一个机器人 */
export const refIndexes = new RefIndexTable()
