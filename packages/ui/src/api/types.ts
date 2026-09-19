/** /admin/* 的返回类型，与 @qqbot/runtime admin.ts 保持一致 */

export interface CommandSpec {
  name: string
  description?: string
  usage?: string
  aliases?: string[]
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
