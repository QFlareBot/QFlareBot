import type { AnyPluginDefinition, Manifest } from '@qqbot/sdk'

/** Worker 绑定：种子的 wrangler.jsonc 与投影器生成的元数据都遵循这些名字 */
export interface RuntimeEnv {
  KV: KVNamespace
  DB: D1Database
  R2?: R2Bucket
  /** 优先用 secret；未设置时回退到 KV 中面板保存的配置 */
  BOT_APPID?: string
  BOT_SECRET?: string
  /** 管理 API 的 Bearer Token；未设置则管理 API 关闭 */
  ADMIN_TOKEN?: string
  [binding: string]: unknown
}

/** 投影器生成的懒加载条目 */
export interface LazyPluginEntry {
  manifest: Manifest
  load: () => Promise<{ default: unknown }>
}

/** 直接传定义（本地开发 / 静态入口）或懒加载条目 */
export type PluginEntry = LazyPluginEntry | AnyPluginDefinition

export interface RuntimeOptions {
  plugins: PluginEntry[]
  /** 投影哈希，用于健康检查与自愈对比 */
  projection?: string
  /** 默认 /webhook */
  webhookPath?: string
  /** 默认 /admin */
  adminPath?: string
  /** 事件时间戳允许偏差，默认 300 秒 */
  timestampToleranceSec?: number
  /** 事件 id 去重保留时间，默认 600 秒 */
  dedupeTtlSec?: number
  /** 同一条消息最多被动回复次数，默认 5（QQ 平台限制） */
  maxPassiveReplies?: number
  /** 命令前缀，默认 ['/']；快照可覆盖 */
  commandPrefixes?: string[]
  /** 测试注入 */
  fetchImpl?: typeof fetch
}

export type ResolvedOptions = Required<Omit<RuntimeOptions, 'projection' | 'fetchImpl'>> & {
  projection: string | undefined
  fetchImpl: typeof fetch
}

/** 运行时快照：每个请求都会读，存 KV，isolate 内短暂缓存 */
export interface Snapshot {
  revision: number
  plugins: Record<string, PluginState>
  commandPrefixes?: string[]
  /** 安全模式：跳过全部插件 */
  safeMode?: boolean
}

export interface PluginState {
  enabled: boolean
  config?: unknown
  /** 覆盖插件声明的优先级 */
  priority?: number
}

export interface BotConfig {
  appId: string
  secret: string
}
