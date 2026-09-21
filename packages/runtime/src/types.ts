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
  /** Worker 的 tag（GET /accounts/.../workers/scripts 返回的 tag，不是名字）。与 CF_TRIGGER_UUID
   *  一起可省略：省略时运行时按 WORKER_NAME 自发现并缓存进 KV（要求仓库已连接 Workers Builds） */
  CF_WORKER_TAG?: string
  /** Builds trigger 的 UUID（GET /accounts/.../builds/workers/{tag}/triggers）；可省略，见上 */
  CF_TRIGGER_UUID?: string
  /** 触发构建的分支，默认 main */
  CF_BUILD_BRANCH?: string
  /** 本 Worker 的脚本名（= wrangler.jsonc 的 name，引导工作流同步写入 vars）。自发现构建目标用 */
  WORKER_NAME?: string
  /** —— 基础设施绑定：由引导工作流写入 secrets，供构建机拉取动态注入 wrangler.generated.jsonc —— */
  CF_WORKER_NAME?: string
  CF_KV_ID?: string
  CF_D1_ID?: string
  CF_R2_NAME?: string
  CF_CUSTOM_DOMAIN?: string
  CF_DEFAULT_DOMAIN?: string
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
  /** Bot 管理员（超级管理员）的用户 openid 名单，面板设置页维护 */
  admins?: string[]
  /** 权限不足时的统一回复文案；未设置则静默跳过（当作没匹配到） */
  permissionDeniedReply?: string
  /**
   * 机器人资料：面板保存凭证时调一次 /users/@me 取回，随快照下发（session.botName/botAvatar）。
   * 不做运行时拉取与缓存——改资料后重新保存一次凭证即可刷新。
   */
  bot?: { name?: string; avatar?: string }
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
