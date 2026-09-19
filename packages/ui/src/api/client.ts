import type { EventRecord, InstallPluginResult, InstallRecord, Snapshot, Status, TestEventResult, TriggerBuildResult } from './types.js'

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
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

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
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; fields?: FieldError[] }
  if (res.status === 401 && path !== '/login') {
    session.clear()
    onUnauthorized?.()
  }
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`, data.fields ?? [])
  return data as T
}

export const api = {
  login: (token: string) => request<{ ok: true; session: string }>('POST', '/login', { token }),
  status: () => request<Status>('GET', '/status'),
  snapshot: () => request<{ ok: true; snapshot: Snapshot }>('GET', '/snapshot'),
  putSnapshot: (snapshot: Snapshot) => request<{ ok: true; snapshot: Snapshot }>('PUT', '/snapshot', snapshot),
  patchPlugin: (name: string, patch: { enabled?: boolean; config?: unknown; priority?: number }) =>
    request<{ ok: true; revision: number }>('PATCH', `/plugins/${encodeURIComponent(name)}`, patch),
  bridgeToken: (name: string) => request<{ ok: true; token: string }>('POST', `/plugins/${encodeURIComponent(name)}/bridge`),
  saveBot: (appId: string, secret: string) => request<{ ok: true; appId: string }>('PUT', '/bot', { appId, secret }),
  events: (limit = 50, before?: number) =>
    request<{ ok: true; events: EventRecord[] }>('GET', `/events?limit=${limit}${before ? `&before=${before}` : ''}`),
  clearEvents: () => request<{ ok: true }>('DELETE', '/events'),
  testEvent: (body: Record<string, unknown>) => request<TestEventResult>('POST', '/test-event', body),
  send: (scene: string, targetId: string, message: unknown) =>
    request<{ ok: boolean; result: { ok: boolean; status: number; messageId?: string; error?: string } }>('POST', '/send', { scene, targetId, message }),
  installPlugin: (source: string) => request<InstallPluginResult>('POST', '/manifest/plugins', { source }),
  triggerBuild: (branch?: string) => request<TriggerBuildResult>('POST', '/builds', branch ? { branch } : undefined),
  builds: () => request<{ ok: true; builds: InstallRecord[] }>('GET', '/builds'),
}
