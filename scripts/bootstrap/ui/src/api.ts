import type { Completion, Connection, ExistingInfo, Gate, InitData, Progress, ProvisionOptions, VerifyResult } from './types.js'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message)
  }

  /** 连不上向导服务：runner 已经结束，或者隧道断了（隧道的报错页是 HTML，解析不出 JSON） */
  get offline(): boolean {
    return this.status === 0
  }
}

let onGate: (gate: Gate) => void = () => {}

/** 任何接口回了 403 + gate，都说明这个浏览器没有向导的使用权 */
export function setGateHandler(handler: (gate: Gate) => void): void {
  onGate = handler
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(
      path,
      body === undefined
        ? { cache: 'no-store' }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    )
  } catch {
    throw new ApiError('连不上向导服务', 0)
  }
  let data: Record<string, unknown>
  try {
    data = (await res.json()) as Record<string, unknown>
  } catch {
    throw new ApiError('连不上向导服务', 0)
  }
  if (!res.ok) {
    if (res.status === 403 && (data.gate === 'locked' || data.gate === 'unclaimed')) onGate(data.gate)
    throw new ApiError(typeof data.error === 'string' ? data.error : `HTTP ${res.status}`, res.status, data)
  }
  return data as T
}

export const api = {
  init: () => request<InitData>('/api/init'),
  verify: (token: string, accountId?: string) => request<VerifyResult>('/api/verify', { token, accountId }),
  existing: (workerName: string) => request<ExistingInfo>(`/api/existing?workerName=${encodeURIComponent(workerName)}`),
  provision: (options: ProvisionOptions) => request<{ started: true }>('/api/provision', options),
  progress: () => request<Progress>('/api/progress'),
  connection: () => request<Connection>('/api/builds-connection'),
  buildsToken: (buildsToken: string) => request<{ ok: true }>('/api/builds-token', { buildsToken }),
  complete: (buildsToken?: string) => request<Completion & { now: number }>('/api/complete', buildsToken ? { buildsToken } : {}),
  exit: () => request<{ ok: true }>('/api/exit', {}),
  cancel: () => request<{ ok: true }>('/api/cancel', {}),
}
