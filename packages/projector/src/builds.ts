import { CloudflareApiError, type CloudflareApiMessage } from './cloudflare.js'

/** 构建记录字段按 Builds API 实际返回收录，其余原样留在 raw 里 */
export interface BuildRecord {
  build_uuid?: string
  uuid?: string
  /** 运行阶段：queued / initializing / running / stopped——完成与否要看 build_outcome */
  status?: string
  /** 终态结果：success / fail / skipped / cancelled / terminated；进行中为空 */
  build_outcome?: string
  branch?: string
  created_at?: string
  build_trigger_metadata?: { branch?: string; commit_hash?: string }
  [key: string]: unknown
}

export interface CloudflareBuildsApiOptions {
  accountId: string
  /** Workers Builds API 只接受 user-scoped token（account-scoped 会返回 Invalid token） */
  apiToken: string
  fetchImpl?: typeof fetch
  baseUrl?: string
}

export interface TriggerBuildOptions {
  /** 构建该分支的当前状态（不 pin 具体 commit） */
  branch: string
  /** 可选：钉住某个提交构建 */
  commitHash?: string
}

/**
 * Workers Builds REST API：触发构建、查询构建状态。
 * 文档：https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/
 */
export class CloudflareBuildsApi {
  readonly #accountId: string
  readonly #token: string
  readonly #fetch: typeof fetch
  readonly #baseUrl: string

  constructor(opts: CloudflareBuildsApiOptions) {
    this.#accountId = opts.accountId
    this.#token = opts.apiToken
    // 包一层箭头函数：全局 fetch 以属性形式被 this.#fetch() 调用时 workerd 会抛 Illegal invocation
    const impl = opts.fetchImpl ?? fetch
    this.#fetch = (input, init) => impl(input, init)
    this.#baseUrl = (opts.baseUrl ?? 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '')
  }

  /** 触发一次构建，返回 build_uuid（响应里缺该字段时回退 uuid/id） */
  async triggerBuild(triggerUuid: string, opts: TriggerBuildOptions): Promise<{ buildUuid: string }> {
    const body: Record<string, string> = { branch: opts.branch }
    if (opts.commitHash) body['commit_hash'] = opts.commitHash
    const result = await this.#request<Record<string, unknown>>(
      'POST',
      `/builds/triggers/${encodeURIComponent(triggerUuid)}/builds`,
      body,
    )
    const buildUuid = [result['build_uuid'], result['uuid'], result['id']].find((v): v is string => typeof v === 'string')
    if (!buildUuid) {
      throw new CloudflareApiError('触发构建的响应缺少 build_uuid', 200, [])
    }
    return { buildUuid }
  }

  /** 列出某个 Worker 的构建记录（新→旧） */
  async listBuilds(workerTag: string): Promise<BuildRecord[]> {
    const result = await this.#request<BuildRecord[] | { items?: BuildRecord[] }>(
      'GET',
      `/builds/workers/${encodeURIComponent(workerTag)}/builds`,
    )
    return Array.isArray(result) ? result : (result.items ?? [])
  }

  async #request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.#token}` }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const url = `${this.#baseUrl}/accounts/${this.#accountId}${path}`
    const res = await this.#fetch(url, body === undefined ? { method, headers } : { method, headers, body: JSON.stringify(body) })
    const text = await res.text()

    let envelope: { success?: boolean; errors?: CloudflareApiMessage[]; result?: T } | undefined
    try {
      envelope = JSON.parse(text) as typeof envelope
    } catch {
      envelope = undefined
    }
    if (!envelope || typeof envelope !== 'object') {
      throw new CloudflareApiError(`Cloudflare API 返回非 JSON 响应（HTTP ${res.status}）：${text.slice(0, 200)}`, res.status, [])
    }
    if (!res.ok || envelope.success === false) {
      const errors = envelope.errors ?? []
      const detail = errors.map((e) => `[${e.code}] ${e.message}`).join('; ') || `HTTP ${res.status}`
      throw new CloudflareApiError(`${method} ${path} 失败：${detail}`, res.status, errors)
    }
    return envelope.result as T
  }
}
