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
  /** 线上这一份的出处（构建机写入）；老部署为 null */
  origin: PluginOrigin | null
  /** 已从 D1 清单移除、线上还在跑：卸载还没生效（重建中或构建失败） */
  removing: boolean
  /** 依赖的服务名 */
  depends: string[]
  /** 提供的服务名 */
  services: string[]
  /** 卸载它会断掉的插件（它们依赖的服务只有它提供） */
  dependents: string[]
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
  /** name 是保存凭证时拉到的机器人昵称；没拉到或老运行时为空 / 缺省 */
  bot: { appId: string; source: 'secret' | 'kv'; name?: string } | null
  webhookPath: string
  bindings: { kv: boolean; d1: boolean; r2: boolean }
  snapshot: { revision: number; safeMode: boolean }
  stats: { total: number; last24h: number; errors24h: number } | null
  plugins: PluginInfo[]
}

/** 换下来的机器人（GET /bot/saved）；AppSecret 留在 Worker 里，不下发 */
export interface SavedBot {
  appId: string
  name: string
  /** 换下时刻（毫秒） */
  savedAt: number
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

/** 插件出处：d1 = 面板装的，repo = 仓库内置的；source 是原始来源（git:owner/repo@commit） */
export interface PluginOrigin {
  from: 'd1' | 'repo'
  source: string
}

/**
 * 改完清单之后的构建：触发了、触发失败（改动本身已生效，重试构建即可）、或者不需要
 * （清单已与线上一致，或按请求暂不构建）
 */
export type BuildOutcome = { buildUuid: string } | { error: string } | { skipped: true; reason: string }

export interface InstallPluginResult {
  ok: true
  plugin: { name: string; version: string; source: string }
  previous?: { version: string; source?: string }
  hash: string
  install: InstallRecord
  build: BuildOutcome
  /** 能装，但要让人知道的事：换了仓库、命令重名、新增权限…… */
  warnings?: string[]
}

/** 预检时的清单摘要 */
export interface ManifestSummary {
  name: string
  version: string
  displayName?: string
  description?: string
  permissions: string[]
  services: string[]
  depends: string[]
  durableObjects: string[]
  commands: string[]
}

/** POST /manifest/plugins { dryRun: true }：跑完全部校验、什么都不写 */
export interface InstallPreview {
  ok: true
  dryRun: true
  plugin: { name: string; version: string; source: string }
  previous?: { version: string; source: string }
  manifest: ManifestSummary
  /** 插件的第三方依赖（包名 → 版本范围）：构建时按插件仓库的 lockfile 安装、打进插件自己的 plugin.js */
  dependencies?: Record<string, string>
  warnings: string[]
  /** 新增了 DO 类：要先往仓库补 migrations，确认后带 acknowledgeDurableObjects 安装 */
  durableObjects: { required: true; message: string } | null
}

export interface CheckUpdateResult {
  ok: true
  name: string
  current: string
  currentVersion?: string
  latestSha: string
  latestVersion: string | null
  upToDate: boolean
  latestSource?: string
  /** 新版本新增的权限 */
  newPermissions?: string[]
  /** 新版本新增的 DO 类：要先改仓库，不能直接批量更新 */
  newDurableObjects?: string[]
}

/** 账本里某个插件最近的一条记录 */
export interface LedgerSummary {
  action: InstallRecord['action']
  status: InstallRecord['status']
  error: string | null
  ts: number
  buildUuid: string | null
}

/** GET /manifest/plugins 的一项：D1 清单里的插件与线上的对照 */
export interface ManagedPlugin {
  name: string
  version: string
  source: string
  addedAt: number
  updatedAt: number
  /** deployed 线上就是这一份；differs 线上是另一份；not_deployed 线上根本没有（等构建或构建失败） */
  state: 'deployed' | 'differs' | 'not_deployed'
  live: { version: string; source: string | null; from: 'd1' | 'repo' | null } | null
  /** 构建机回报的构建错误（只对当前 source 有效） */
  buildError: string | null
  lastRecord: LedgerSummary | null
  manifest: ManifestSummary | null
}

export interface ManagedPluginsResult {
  ok: true
  hash: string
  liveHash: string | null
  /** D1 清单是否已全部上线；null 表示老部署判断不了 */
  inSync: boolean | null
  building: boolean
  plugins: ManagedPlugin[]
  /** 线上还在跑、D1 里已经删了：卸载还没生效 */
  removing: Array<{ name: string; version: string; source: string; lastRecord: LedgerSummary | null }>
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
  build: BuildOutcome
  /** 例如：还有插件依赖它提供的服务 */
  warnings?: string[]
  data: {
    purged: boolean
    hook: 'none' | 'ok' | 'failed'
    hookError?: string
    kvKeys?: number
    tables?: string[]
    r2Objects?: number
  }
}
