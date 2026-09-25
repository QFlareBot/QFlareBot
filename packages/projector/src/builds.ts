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

/**
 * 构建机上的构建与部署命令。
 *
 * Worker（连上仓库后自动写 trigger）与引导脚本（无 UI 模式打进 Summary 让人照抄）都要用它，
 * 但两者分属不同的构建世界——Worker 打成 bundle，引导是裸 Node 脚本，没法共享一个模块。
 * 所以 `scripts/bootstrap/lib.mjs` 里有一份同源副本，由 builds.test.ts 断言两边一致。
 */
export const BUILD_COMMAND = 'pnpm build && pnpm --filter @qqbot/seed run manifest:prepare'
export const DEPLOY_COMMAND = 'pnpm --filter @qqbot/seed run manifest:deploy'

/** listBuilds 默认页大小：够账本里最近这些记录回填，又不至于拉回一大页 */
export const BUILDS_PAGE_SIZE = 50

/** 可改的 trigger 配置字段（只收录本项目会写的几项，其余不碰） */
export interface TriggerConfig {
  build_command?: string
  deploy_command?: string
  root_directory?: string
}

/** 构建环境变量的值；`is_secret` 为真时后台不再回显 */
export interface TriggerEnvValue {
  value: string
  is_secret?: boolean
}

/** trigger 列表里的一项，只收录本项目用到的字段 */
export interface BuildTrigger {
  uuid: string
  /** 连接仓库时设的分支规则：生产 trigger 是具体分支名，预览 trigger 是 "*" 这类通配；字段缺失时为空 */
  branchIncludes: string[]
}

/**
 * trigger 的生产分支：branch_includes 里第一个不带通配的名字。
 * 取不到（字段缺失，或只有通配）返回 null，由调用方决定回退——别在这里替人猜 main。
 */
export function productionBranchOf(trigger: BuildTrigger): string | null {
  return trigger.branchIncludes.find((b) => b !== '' && !b.includes('*')) ?? null
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

  /**
   * 列出某个 Worker 的构建记录（新→旧）。
   *
   * 必须显式给 `per_page`：默认页很小，账本里等着回填的构建一旦翻出返回范围，
   * 调用方就会把它当成「这个构建不存在」并按失败收敛——而它其实成功了。
   */
  async listBuilds(workerTag: string, perPage = BUILDS_PAGE_SIZE): Promise<BuildRecord[]> {
    const result = await this.#request<BuildRecord[] | { items?: BuildRecord[] }>(
      'GET',
      `/builds/workers/${encodeURIComponent(workerTag)}/builds?per_page=${perPage}`,
    )
    return Array.isArray(result) ? result : (result.items ?? [])
  }

  /**
   * 改 trigger 的构建配置。仓库连上 Workers Builds 之后，构建命令与部署命令
   * 由引导直接写进去——这两项以前只出现在文档里让用户手抄。
   * 需要 token 具备 Workers Builds Configuration (Edit)，触发构建用的就是这个权限。
   */
  async updateTrigger(triggerUuid: string, config: TriggerConfig): Promise<void> {
    await this.#request('PATCH', `/builds/triggers/${encodeURIComponent(triggerUuid)}`, config)
  }

  /** 写 trigger 的构建环境变量（整体合并，未列出的键保持不变） */
  async putTriggerEnv(triggerUuid: string, vars: Record<string, TriggerEnvValue>): Promise<void> {
    await this.#request('PATCH', `/builds/triggers/${encodeURIComponent(triggerUuid)}/environment_variables`, vars)
  }

  /**
   * 列出账号下的 Worker 脚本。`id` 是脚本名，`tag` 是 Builds API 用的标识——
   * 两者不是一回事（填错是账本"永远构建中"的经典原因）。
   */
  async listScripts(): Promise<Array<{ id: string; tag: string }>> {
    const result = await this.#request<Array<{ id?: string; tag?: string }> | { items?: Array<{ id?: string; tag?: string }> }>(
      'GET',
      '/workers/scripts',
    )
    const items = Array.isArray(result) ? result : (result.items ?? [])
    return items
      .filter((s): s is { id: string; tag: string } => typeof s.id === 'string' && typeof s.tag === 'string')
      .map((s) => ({ id: s.id, tag: s.tag }))
  }

  /** 列出某个 Worker 的 Builds trigger；仓库连上 Workers Builds 之前为空 */
  async listTriggers(workerTag: string): Promise<BuildTrigger[]> {
    type Raw = { trigger_uuid?: unknown; uuid?: unknown; id?: unknown; branch_includes?: unknown }
    const result = await this.#request<Raw[] | { items?: Raw[] }>(
      'GET',
      `/builds/workers/${encodeURIComponent(workerTag)}/triggers`,
    )
    const items = Array.isArray(result) ? result : (result.items ?? [])
    return items.flatMap((t) => {
      const uuid = [t.trigger_uuid, t.uuid, t.id].find((v): v is string => typeof v === 'string')
      if (!uuid) return []
      const includes = Array.isArray(t.branch_includes) ? t.branch_includes.filter((b): b is string => typeof b === 'string') : []
      return [{ uuid, branchIncludes: includes }]
    })
  }

  /**
   * 查某个 Worker 的生产 Builds trigger，返回 trigger_uuid。
   * 仓库连上 Workers Builds 之前该列表为空——所以自发现只能在连接之后成功。
   *
   * 连接时勾了「非生产分支构建」，Cloudflare 会另建一个预览 trigger（branch_includes 只有 "*"），
   * 不能取列表第一个：往预览 trigger 写部署命令、从它触发构建，都会打到错的那一路。
   * `scripts/bootstrap/lib.mjs` 的 pickProductionTrigger 是同一条规则。
   */
  async getTriggerUuid(workerTag: string): Promise<string | null> {
    const production = (await this.listTriggers(workerTag)).find((t) => !t.branchIncludes.length || productionBranchOf(t) !== null)
    return production?.uuid ?? null
  }

  async #request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
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
