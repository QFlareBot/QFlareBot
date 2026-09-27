import type { CachedToken, TokenCache } from '@qqbot/api'
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

/** 测试用：清掉 isolate 内缓存（快照、面板保存的凭证、token） */
export function resetSnapshotCache(): void {
  snapshotCache = null
  botConfigCache = null
  tokenMemory.clear()
}

/** 两个 Worker Secret 都配了才算数，这时它们优先于面板保存的凭证 */
export function botFromSecrets(env: RuntimeEnv): BotConfig | null {
  return env.BOT_APPID && env.BOT_SECRET ? { appId: env.BOT_APPID, secret: env.BOT_SECRET } : null
}

export async function readBotConfig(env: RuntimeEnv): Promise<BotConfig | null> {
  return botFromSecrets(env) ?? readStoredBotConfig(env)
}

/**
 * 面板保存的凭证同样每个请求都要读，缓存道理与快照相同（见 SNAPSHOT_CACHE_MS）。
 * 没配凭证（null）也缓存，否则没配好的机器人每个请求照样读一次 KV。
 * `rt:bot` 只有 writeBotConfig 在写，它顺手刷新缓存，面板保存后本 isolate 立刻用上新凭证
 */
let botConfigCache: { value: BotConfig | null; at: number } | null = null

function storedBot(value: Partial<BotConfig> | null | undefined): BotConfig | null {
  return value?.appId && value.secret ? { appId: value.appId, secret: value.secret } : null
}

/** 只看 KV 里面板保存的那份，不管 Worker Secret */
export async function readStoredBotConfig(env: RuntimeEnv, force = false): Promise<BotConfig | null> {
  if (!force && botConfigCache && Date.now() - botConfigCache.at < SNAPSHOT_CACHE_MS) return botConfigCache.value
  const value = storedBot(await env.KV.get<BotConfig>(Keys.botConfig, 'json'))
  botConfigCache = { value, at: Date.now() }
  return value
}

export async function writeBotConfig(env: RuntimeEnv, config: BotConfig): Promise<void> {
  await env.KV.put(Keys.botConfig, JSON.stringify(config))
  botConfigCache = { value: storedBot(config), at: Date.now() }
  tokenMemory.clear()
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

/**
 * token 的 isolate 内副本，按 AppID 分开。每个请求都会新建 QQBotClient，没有这一层的话每次调 API 都读一次 KV。
 * 换号时 writeBotConfig 清掉本 isolate 的；别的 isolate 里旧号的副本按 AppID 对不上，不会拿给新号用
 */
const tokenMemory = new Map<string, CachedToken>()
/**
 * 离过期不到这么久就不信内存里的、回头读 KV。与 token 提供者默认的提前量一致：
 * 内存把快过期的交出去，提供者会直接找 QQ 换新的，看不到别的 isolate 已经换好放进 KV 的那个
 */
const TOKEN_MEMORY_SKEW_SEC = 60

/** KV 里的 token 附带换它的 AppID；老运行时写的没有这个字段 */
type StoredToken = CachedToken & { appId?: string }

/**
 * token 存 KV 让所有 isolate 共享，避免冷启动风暴时反复取 token；前面再挡一层 isolate 内存。
 * `appId` 不传时所有号共用一份内存副本（老调用方式）
 */
export function kvTokenCache(env: RuntimeEnv, appId = ''): TokenCache {
  return {
    get: async () => {
      const memo = tokenMemory.get(appId)
      if (memo && memo.expiresAt - TOKEN_MEMORY_SKEW_SEC > Date.now() / 1000) return memo
      const stored = await env.KV.get<StoredToken>(Keys.token, 'json')
      // 换号后别的节点可能还读到 KV 里旧号的 token（边缘缓存），标了 AppID 就认得出来；没标的照旧用
      if (!stored || (appId && stored.appId && stored.appId !== appId)) return null
      const value = { token: stored.token, expiresAt: stored.expiresAt }
      tokenMemory.set(appId, value)
      return value
    },
    set: async (value) => {
      tokenMemory.set(appId, value)
      const ttl = Math.max(60, value.expiresAt - Math.floor(Date.now() / 1000))
      try {
        await env.KV.put(Keys.token, JSON.stringify(appId ? { ...value, appId } : value), { expirationTtl: ttl })
      } catch {
        // KV 写不进去（当天写额度用完）不影响本 isolate 用内存里这份，别的 isolate 各自再换一次
      }
    },
  }
}

// 事件去重见 dedupe.ts：有 D1 时用主键冲突原子声明，没有才退回这里的 KV 键
