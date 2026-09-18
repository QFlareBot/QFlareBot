import type { Projection, VersionMetadata } from './types.js'

export interface CloudflareApiMessage {
  code: number
  message: string
}

export class CloudflareApiError extends Error {
  override readonly name = 'CloudflareApiError'
  constructor(
    message: string,
    readonly status: number,
    readonly errors: CloudflareApiMessage[],
  ) {
    super(message)
  }
}

interface Envelope<T> {
  success: boolean
  errors?: CloudflareApiMessage[]
  result: T
}

export interface WorkerVersion {
  id: string
  number?: number
  metadata?: { created_on?: string; source?: string; author_email?: string }
  annotations?: Record<string, string>
}

export interface WorkerDeployment {
  id: string
  created_on?: string
  source?: string
  strategy: 'percentage'
  versions: Array<{ percentage: number; version_id: string }>
  annotations?: Record<string, string>
}

export interface CloudflareWorkersApiOptions {
  accountId: string
  apiToken: string
  fetchImpl?: typeof fetch
  baseUrl?: string
}

export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4'
export const MODULE_CONTENT_TYPE = 'application/javascript+module'

export class CloudflareWorkersApi {
  readonly #accountId: string
  readonly #token: string
  readonly #fetch: typeof fetch
  readonly #baseUrl: string

  constructor(opts: CloudflareWorkersApiOptions) {
    this.#accountId = opts.accountId
    this.#token = opts.apiToken
    // 包一层箭头函数：全局 fetch 以属性形式被 this.#fetch() 调用时 workerd 会抛 Illegal invocation
    const impl = opts.fetchImpl ?? fetch
    this.#fetch = (input, init) => impl(input, init)
    this.#baseUrl = (opts.baseUrl ?? CLOUDFLARE_API_BASE).replace(/\/+$/, '')
  }

  async uploadVersion(opts: {
    scriptName: string
    projection: Projection
    message?: string
  }): Promise<{ versionId: string }> {
    const { projection } = opts
    const metadata: VersionMetadata =
      opts.message === undefined
        ? projection.metadata
        : {
            ...projection.metadata,
            annotations: { ...projection.metadata.annotations, 'workers/message': opts.message },
          }

    const form = new FormData()
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json')
    for (const [name, code] of Object.entries(projection.modules)) {
      form.append(name, new Blob([code], { type: MODULE_CONTENT_TYPE }), name)
    }

    const result = await this.#request<{ id: string }>(
      'POST',
      `/workers/scripts/${encodeURIComponent(opts.scriptName)}/versions`,
      { body: form },
    )
    return { versionId: result.id }
  }

  async deployVersion(opts: {
    scriptName: string
    versionId: string
    message?: string
  }): Promise<{ deploymentId: string }> {
    const body: Record<string, unknown> = {
      strategy: 'percentage',
      versions: [{ percentage: 100, version_id: opts.versionId }],
    }
    if (opts.message !== undefined) body['annotations'] = { 'workers/message': opts.message }
    const result = await this.#request<{ id: string }>(
      'POST',
      `/workers/scripts/${encodeURIComponent(opts.scriptName)}/deployments`,
      { json: body },
    )
    return { deploymentId: result.id }
  }

  async listVersions(scriptName: string): Promise<WorkerVersion[]> {
    const result = await this.#request<{ items?: WorkerVersion[] } | WorkerVersion[]>(
      'GET',
      `/workers/scripts/${encodeURIComponent(scriptName)}/versions`,
    )
    return Array.isArray(result) ? result : (result.items ?? [])
  }

  async listDeployments(scriptName: string): Promise<WorkerDeployment[]> {
    const result = await this.#request<{ deployments?: WorkerDeployment[] } | WorkerDeployment[]>(
      'GET',
      `/workers/scripts/${encodeURIComponent(scriptName)}/deployments`,
    )
    return Array.isArray(result) ? result : (result.deployments ?? [])
  }

  async getWorkersSubdomain(): Promise<string> {
    const result = await this.#request<{ subdomain: string }>('GET', '/workers/subdomain')
    return result.subdomain
  }

  /** 版本预览地址：`<versionId 前 8 位>-<scriptName>.<subdomain>.workers.dev` */
  previewUrl(opts: { scriptName: string; versionId: string; subdomain: string }): string {
    return `https://${opts.versionId.slice(0, 8)}-${opts.scriptName}.${opts.subdomain}.workers.dev`
  }

  async #request<T>(
    method: 'GET' | 'POST',
    path: string,
    init: { body?: FormData; json?: unknown } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.#token}` }
    let body: FormData | string | undefined = init.body
    if (init.json !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(init.json)
    }

    const url = `${this.#baseUrl}/accounts/${this.#accountId}${path}`
    const res = await this.#fetch(url, body === undefined ? { method, headers } : { method, headers, body })
    const text = await res.text()

    let envelope: Envelope<T> | undefined
    try {
      envelope = JSON.parse(text) as Envelope<T>
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
    return envelope.result
  }
}
