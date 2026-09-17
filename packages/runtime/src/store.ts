import type { TokenCache } from '@qqbot/api'
import type { BotConfig, RuntimeEnv, Snapshot } from './types.js'

/** 运行时自用的 KV 键，与插件前缀 `p:` 分开 */
export const Keys = {
  botConfig: 'rt:bot',
  snapshot: 'rt:snapshot',
  token: 'rt:token',
  event: (id: string) => `rt:evt:${id}`,
  installed: (name: string) => `rt:installed:${name}`,
} as const

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
  const stored = await env.KV.get<BotConfig>(Keys.botConfig, 'json')
  return stored?.appId && stored.secret ? stored : null
}

export async function writeBotConfig(env: RuntimeEnv, config: BotConfig): Promise<void> {
  await env.KV.put(Keys.botConfig, JSON.stringify(config))
  await env.KV.delete(Keys.token)
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

/** 事件去重：首次见到返回 true 并登记 */
export async function claimEvent(env: RuntimeEnv, id: string, ttlSec: number): Promise<boolean> {
  const key = Keys.event(id)
  if (await env.KV.get(key)) return false
  await env.KV.put(key, '1', { expirationTtl: Math.max(60, ttlSec) })
  return true
}
