/** /admin/* 的返回类型，与 @qqbot/runtime admin.ts 保持一致 */

export interface CommandSpec {
  name: string
  description?: string
  usage?: string
  aliases?: string[]
  /** 权限层级（bot_admin / group_admin / member），同步指令面板时映射为 only_admin */
  permission?: string
}

export interface PluginInfo {
  name: string
  version: string
  displayName: string
  description: string
  enabled: boolean
  priority: number
  config: unknown
  configSchema: JsonSchema | null
  permissions: string[]
  error: string | null
  /** 来自 D1 清单（面板装进来的）才可卸载；仓库内置插件要改 qqbot.manifest.json 重新构建 */
  installed: boolean
  commands: CommandSpec[]
  events: string[]
  buttons: string[]
  cron: Array<{ name: string; cron: string }>
  routes: Array<{ method: string; path: string; auth?: string }>
  ui: { path: string; title?: string; icon?: string } | null
}

export interface JsonSchema {
  type?: string
  title?: string
  description?: string
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
  enum?: unknown[]
  default?: unknown
  minimum?: number
  maximum?: number
  required?: string[]
  [key: string]: unknown
}

export interface Status {
  ok: true
  runtime: string
  projection: string | null
  bot: { appId: string; source: 'secret' | 'kv' } | null
  webhookPath: string
  bindings: { kv: boolean; d1: boolean; r2: boolean }
  snapshot: { revision: number; safeMode: boolean }
  stats: { total: number; last24h: number; errors24h: number } | null
  plugins: PluginInfo[]
}

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
  failed: number
}

export interface MatchRecord {
  plugin: string
  kind: 'command' | 'regex' | 'event' | 'button'
  name: string
}

export interface TestEventResult {
  ok: true
  session: {
    event: string
    scene: string
    content: string
    userId: string
    canReply: boolean
    interaction: { type: string; buttonId: string } | null
  }
  matched: MatchRecord[]
  errors: Array<{ plugin: string; stage: string; message: string }>
  outbox: Array<{ target: { scene: string; id: string }; message: unknown; options?: Record<string, unknown> }>
  acks: Array<{ interactionId: string; code: number }>
  recalls: string[]
  streams: Array<{ index: number; content: string; final: boolean }>
}

export interface Snapshot {
  revision: number
  plugins: Record<string, { enabled: boolean; config?: unknown; priority?: number }>
  commandPrefixes?: string[]
  safeMode?: boolean
  /** Bot 管理员（超级管理员）的用户 openid 名单 */
  admins?: string[]
  /** 权限不足时的统一回复文案；未设置则静默跳过 */
  permissionDeniedReply?: string
}

/** —— 自部署（安装与构建账本），与 runtime 的 manifestStore.ts 保持一致 —— */

export interface InstallRecord {
  id: string
  action: 'install' | 'upgrade' | 'uninstall' | 'build'
  name: string | null
  source: string | null
  manifestHash: string
  buildUuid: string | null
  cfStatus: string | null
  status: 'pending' | 'building' | 'ok' | 'failed'
  commitHash: string | null
  error: string | null
  ts: number
}

export interface InstallPluginResult {
  ok: true
  plugin: { name: string; version: string; source: string }
  previous?: { version: string }
  hash: string
  install: InstallRecord
}

export interface TriggerBuildResult {
  ok: true
  buildUuid: string
  branch: string
  hash: string
  install: InstallRecord
}

/** —— 存储视图，与 runtime 的 purge.ts 保持一致 —— */

export interface StorageUsage {
  plugin: string
  kvKeys: number
  tables: { name: string; rows: number }[]
  r2Objects: number
  r2Bytes: number
}

export interface StorageReport {
  ok: true
  bindings: { kv: boolean; d1: boolean; r2: boolean }
  plugins: StorageUsage[]
  /** 不属于任何已装插件的残留数据——卸载时选了保留，或插件从清单里被手工移掉 */
  orphans: StorageUsage[]
  /** 连候选插件名都对不上的表，只能人工处置 */
  unattributedTables: string[]
}

export interface UninstallResult {
  ok: true
  removed: { name: string; version: string; source: string }
  /** 卸载后就地触发重建；失败时卸载本身仍然生效（清单已改），需要手动重试构建 */
  build: { buildUuid: string } | { error: string }
  data: {
    purged: boolean
    hook: 'none' | 'ok' | 'failed'
    hookError?: string
    kvKeys?: number
    tables?: string[]
    r2Objects?: number
  }
}
