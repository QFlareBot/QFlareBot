import type {
  BuildOutcome,
  CheckUpdateResult,
  EventRecord,
  GroupScope,
  InstallPluginResult,
  InstallPreview,
  InstallRecord,
  ManagedPluginsResult,
  SavedBot,
  Snapshot,
  Status,
  StorageReport,
  TestEventResult,
  TriggerBuildResult,
  UninstallResult,
} from './types.js'

const SESSION_KEY = 'qqbot.session'

/** 服务端按 configSchema 校验失败时逐字段返回 */
export interface FieldError {
  path: string
  message: string
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** 仅 400 的表单校验错误会带上 */
    readonly fields: FieldError[] = [],
    /** 机器可读的失败原因，用于区分「需要用户确认后重试」这类可恢复失败 */
    readonly code?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** 插件声明了 Durable Object，需要先往仓库 wrangler.jsonc 补 migrations 再确认安装 */
export const DO_MIGRATION_REQUIRED = 'durable_objects_migration_required'

/** depends 的服务没人提供；批量安装时提供者可能就在同一批里（老版本 Worker 不带这个 code） */
export const DEPENDENCIES_MISSING = 'dependencies_missing'

export const session = {
  get: () => localStorage.getItem(SESSION_KEY),
  set: (token: string) => localStorage.setItem(SESSION_KEY, token),
  clear: () => localStorage.removeItem(SESSION_KEY),
}

let onUnauthorized: (() => void) | null = null
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  const token = session.get()
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'

  const res = await fetch(`/admin${path}`, { method, headers, body: body === undefined ? null : JSON.stringify(body) })
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; fields?: FieldError[]; code?: string }
  if (res.status === 401 && path !== '/login') {
    session.clear()
    onUnauthorized?.()
  }
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`, data.fields ?? [], data.code)
  return data as T
}

export const api = {
  login: (token: string) => request<{ ok: true; session: string }>('POST', '/login', { token }),
  status: () => request<Status>('GET', '/status'),
  snapshot: () => request<{ ok: true; snapshot: Snapshot }>('GET', '/snapshot'),
  putSnapshot: (snapshot: Snapshot) => request<{ ok: true; snapshot: Snapshot }>('PUT', '/snapshot', snapshot),
  patchPlugin: (name: string, patch: { enabled?: boolean; config?: unknown; priority?: number; groups?: GroupScope | null }) =>
    request<{ ok: true; revision: number }>('PATCH', `/plugins/${encodeURIComponent(name)}`, patch),
  bridgeToken: (name: string) => request<{ ok: true; token: string }>('POST', `/plugins/${encodeURIComponent(name)}/bridge`),
  saveBot: (appId: string, secret: string) => request<{ ok: true; appId: string }>('PUT', '/bot', { appId, secret }),
  /** 扫码创建机器人：key 由面板保管，轮询时带回 */
  startBotBind: () => request<{ ok: true; taskId: string; key: string; qrUrl: string }>('POST', '/bot/bind'),
  pollBotBind: (taskId: string, key: string) =>
    request<{ ok: true; status: 'pending' | 'expired' | 'created'; appId?: string }>('POST', '/bot/bind/poll', { taskId, key }),
  /** 换下来的机器人：换 AppID 时旧的自动存进来，切回不用再填 AppSecret */
  savedBots: () => request<{ ok: true; bots: SavedBot[] }>('GET', '/bot/saved'),
  switchBot: (appId: string) => request<{ ok: true; appId: string }>('POST', '/bot/switch', { appId }),
  removeSavedBot: (appId: string) => request<{ ok: true; appId: string }>('DELETE', `/bot/saved/${encodeURIComponent(appId)}`),
  events: (limit = 50, before?: number) =>
    request<{ ok: true; events: EventRecord[] }>('GET', `/events?limit=${limit}${before ? `&before=${before}` : ''}`),
  clearEvents: () => request<{ ok: true }>('DELETE', '/events'),
  testEvent: (body: Record<string, unknown>) => request<TestEventResult>('POST', '/test-event', body),
  send: (scene: string, targetId: string, message: unknown) =>
    request<{ ok: boolean; result: { ok: boolean; status: number; messageId?: string; error?: string } }>('POST', '/send', { scene, targetId, message }),
  /** QQ 端点透传：平台响应原样返回（HTTP 200 内嵌 status），便于在面板上看到平台回复 */
  qqPanels: (scope: string) =>
    request<{ ok: boolean; status: number; data: unknown }>('GET', `/qq/panels?scope=${encodeURIComponent(scope)}`),
  sendQQPanels: (body: unknown) => request<{ ok: boolean; status: number; data: unknown }>('POST', '/qq/panels', body),
  deleteQQPanel: (panelId: string) =>
    request<{ ok: boolean; status: number; data: unknown }>('DELETE', `/qq/panels/${encodeURIComponent(panelId)}`),
  createUrlLink: (body: Record<string, unknown>) => request<{ ok: boolean; status: number; data: unknown }>('POST', '/qq/url-link', body),
  qqMenu: () => request<{ ok: boolean; status: number; data: unknown }>('GET', '/qq/menu'),
  saveQQMenu: (body: unknown) => request<{ ok: boolean; status: number; data: unknown }>('PUT', '/qq/menu', body),
  /** build: false 只写清单不构建（批量更新时逐个写，最后调一次 triggerBuild） */
  installPlugin: (source: string, opts: { acknowledgeDurableObjects?: boolean; build?: boolean } = {}) =>
    request<InstallPluginResult>('POST', '/manifest/plugins', {
      source,
      ...(opts.acknowledgeDurableObjects ? { acknowledgeDurableObjects: true } : {}),
      ...(opts.build === false ? { build: false } : {}),
    }),
  /** 只预检不写：清单摘要、权限、警告与 DO 提示 */
  previewInstall: (source: string) => request<InstallPreview>('POST', '/manifest/plugins', { source, dryRun: true }),
  /** D1 清单里的插件与线上的对照：已上线 / 线上是另一份 / 没上线 */
  managedPlugins: () => request<ManagedPluginsResult>('GET', '/manifest/plugins'),
  checkPluginUpdate: (name: string) =>
    request<CheckUpdateResult>('POST', `/manifest/plugins/${encodeURIComponent(name)}/check-update`),
  updatePlugin: (name: string) =>
    request<{
      ok: true
      name: string
      upToDate?: boolean
      previous?: { version: string }
      latestSource?: string
      install?: { status: string }
      build?: { buildUuid?: string; error?: string }
    }>('POST', `/manifest/plugins/${encodeURIComponent(name)}/update`),
  triggerBuild: (branch?: string) => request<TriggerBuildResult>('POST', '/builds', branch ? { branch } : undefined),
  builds: () => request<{ ok: true; builds: InstallRecord[]; syncError?: string }>('GET', '/builds'),
  /** purge 为真时连插件数据一起清；默认保留，之后会在存储页列为孤儿 */
  uninstallPlugin: (name: string, purge = false) =>
    request<UninstallResult>('DELETE', `/manifest/plugins/${encodeURIComponent(name)}${purge ? '?purge=true' : ''}`),
  storage: () => request<StorageReport>('GET', '/storage'),
  purgeOrphan: (name: string) =>
    request<{ ok: true; plugin: string; kvKeys: number; tables: string[]; r2Objects: number }>(
      'DELETE',
      `/storage/orphans/${encodeURIComponent(name)}`,
    ),
}

/** 改完清单之后构建的去向，拼成一句 toast：触发了 / 不需要 / 触发失败（改动本身已生效） */
export function describeBuild(done: string, build: BuildOutcome): { text: string; level: 'success' | 'warning' } {
  if ('buildUuid' in build) return { text: `${done}，已触发构建`, level: 'success' }
  if ('skipped' in build) return { text: `${done}（${build.reason}）`, level: 'success' }
  return { text: `${done}，但触发构建失败：${build.error}`, level: 'warning' }
}
