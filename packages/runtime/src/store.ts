import type { TokenCache } from '@qqbot/api'
import type { BotConfig, RuntimeEnv, SavedBot, Snapshot } from './types.js'

/** 运行时自用的 KV 键，与插件前缀 `p:` 分开 */
export const Keys = {
  /** 当前在用的机器人。换号只改这一个键，老运行时与 probe 脚本照旧能读 */
  botConfig: 'rt:bot',
  /** 换下来的机器人（SavedBot[]，最近换下的在前） */
  savedBots: 'rt:bot_saved',
  snapshot: 'rt:snapshot',
  token: 'rt:token',
  event: (id: string) => `rt:evt:${id}`,
  /** CF_WORKER_TAG / CF_TRIGGER_UUID 自发现结果（env 未配置时才有内容） */
  cfBuildTargets: 'rt:cf_build_targets',
  /** 已把构建命令与清单环境变量写进 trigger 的标记（只写一次，不覆盖用户后来的手改） */
  cfTriggerConfigured: 'rt:cf_trigger_configured',
  /** 上次由 Cron 同步构建账本的时刻（节流用） */
  cfLedgerSyncedAt: 'rt:cf_ledger_synced_at',
  installed: (name: string) => `rt:installed:${name}`,
} as const

/**
 * isolate 内缓存，省掉每个事件一次 KV 读。
 *
 * 注意它**不是**配置生效延迟的瓶颈：KV 的 get 默认就带 60 秒边缘缓存，写入
 * 「may take up to 60 seconds or more」才在其他节点可见，所以这 10 秒完全被
 * 那 60 秒吞掉，调小它不会让改配置更快生效。写入方自己的 isolate 由
 * writeSnapshot 直接刷新缓存，因此面板保存后本地立刻可见；跨节点则要等 KV。
 * 想要「保存即全网生效」只能把快照挪到 D1（强一致，但每个事件多一次查询）。
 */
const SNAPSHOT_CACHE_MS = 10_000
let snapshotCache: { value: Snapshot; at: number } | null = null

export const EMPTY_SNAPSHOT: Snapshot = { revision: 0, plugins: {} }

export async function readSnapshot(env: RuntimeEnv, force = false): Promise<Snapshot> {
  if (!force && snapshotCache && Date.now() - snapshotCache.at < SNAPSHOT_CACHE_MS) return snapshotCache.value
  const value = (await env.KV.get<Snapshot>(Keys.snapshot, 'json')) ?? EMPTY_SNAPSHOT
  snapshotCache = { value, at: Date.now() }
  return value
}

export async function writeSnapshot(env: RuntimeEnv, snapshot: Snapshot): Promise<Snapshot> {
  const next: Snapshot = { ...snapshot, revision: snapshot.revision + 1 }
  await env.KV.put(Keys.snapshot, JSON.stringify(next))
  snapshotCache = { value: next, at: Date.now() }
  return next
}

/** 测试用：清掉 isolate 内缓存 */
export function resetSnapshotCache(): void {
  snapshotCache = null
}

export async function readBotConfig(env: RuntimeEnv): Promise<BotConfig | null> {
  if (env.BOT_APPID && env.BOT_SECRET) return { appId: env.BOT_APPID, secret: env.BOT_SECRET }
  return readStoredBotConfig(env)
}

/** 只看 KV 里面板保存的那份，不管 Worker Secret */
export async function readStoredBotConfig(env: RuntimeEnv): Promise<BotConfig | null> {
  const stored = await env.KV.get<BotConfig>(Keys.botConfig, 'json')
  return stored?.appId && stored.secret ? { appId: stored.appId, secret: stored.secret } : null
}

export async function writeBotConfig(env: RuntimeEnv, config: BotConfig): Promise<void> {
  await env.KV.put(Keys.botConfig, JSON.stringify(config))
  await env.KV.delete(Keys.token)
}

/** 换下来的机器人留多少个，超出丢掉换下最久的 */
const SAVED_BOTS_LIMIT = 20

export async function readSavedBots(env: RuntimeEnv): Promise<SavedBot[]> {
  const list = await env.KV.get<SavedBot[]>(Keys.savedBots, 'json')
  return Array.isArray(list) ? list.filter((b) => b?.appId && b.secret) : []
}

export async function writeSavedBots(env: RuntimeEnv, list: SavedBot[]): Promise<void> {
  if (list.length) await env.KV.put(Keys.savedBots, JSON.stringify(list.slice(0, SAVED_BOTS_LIMIT)))
  else await env.KV.delete(Keys.savedBots)
}

/** 快照里的机器人资料，只在属于 appId 这个号时返回；老快照没标 appId，按属于它处理 */
export function profileOf(snapshot: Snapshot, appId: string | undefined): Snapshot['bot'] {
  const bot = snapshot.bot
  return bot && appId && (bot.appId ?? appId) === appId ? bot : undefined
}

/** token 存 KV 让所有 isolate 共享，避免冷启动风暴时反复取 token */
export function kvTokenCache(env: RuntimeEnv): TokenCache {
  return {
    get: () => env.KV.get(Keys.token, 'json'),
    set: async (value) => {
      const ttl = Math.max(60, value.expiresAt - Math.floor(Date.now() / 1000))
      await env.KV.put(Keys.token, JSON.stringify(value), { expirationTtl: ttl })
    },
  }
}

// 事件去重见 dedupe.ts：有 D1 时用主键冲突原子声明，没有才退回这里的 KV 键
