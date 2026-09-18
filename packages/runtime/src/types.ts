import type { AnyPluginDefinition, Manifest } from '@qqbot/sdk'
import type { AssetBundle } from './assets.js'

/** Worker 绑定：种子的 wrangler.jsonc 与投影器生成的元数据都遵循这些名字 */
export interface RuntimeEnv {
  KV: KVNamespace
  /** 可选：缺省时事件记录关闭、插件 ctx.db 调用抛错（免费版 D1 配额有限） */
  DB?: D1Database
  R2?: R2Bucket
  /** 优先用 secret；未设置时回退到 KV 中面板保存的配置 */
  BOT_APPID?: string
  BOT_SECRET?: string
  /** 管理 API 的 Bearer Token；未设置则管理 API 关闭 */
  ADMIN_TOKEN?: string
  /** 构建清单端点（/admin/build-manifest）的专用令牌；未配置时该端点走 ADMIN_TOKEN 鉴权 */
  BUILD_TOKEN?: string
  /** —— 自部署：由 Worker 触发 Workers Builds 重建（见 seed README 的设置步骤）—— */
  /** Cloudflare 账号 ID */
  CF_ACCOUNT_ID?: string
  /** Builds API 的 user-scoped API token（权限：Workers Builds Configuration Edit + Workers Scripts Read） */
  CF_BUILDS_TOKEN?: string
  /** Worker 的 tag（GET /accounts/.../workers/scripts 返回的 id，不是名字） */
  CF_WORKER_TAG?: string
  /** Builds trigger 的 UUID（GET /accounts/.../builds/workers/{tag}/triggers） */
  CF_TRIGGER_UUID?: string
  /** 触发构建的分支，默认 main */
  CF_BUILD_BRANCH?: string
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
  /** 管理面板的静态资源；不传则没有面板，只有 JSON 管理 API */
  ui?: AssetBundle
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

export type ResolvedOptions = Required<Omit<RuntimeOptions, 'projection' | 'fetchImpl' | 'ui'>> & {
  projection: string | undefined
  ui: AssetBundle | undefined
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
