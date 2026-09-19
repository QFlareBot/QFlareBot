import type { DeployResult, DeployStep, Projection } from './types.js'

/** deploy 只依赖这几个方法，便于测试时注入假实现 */
export interface DeployApi {
  uploadVersion(opts: { scriptName: string; projection: Projection; message?: string }): Promise<{ versionId: string }>
  deployVersion(opts: { scriptName: string; versionId: string; message?: string }): Promise<unknown>
  getWorkersSubdomain(): Promise<string>
  previewUrl(opts: { scriptName: string; versionId: string; subdomain: string }): string
  /**
   * 可选：secret 保全校验。上传前不带 versionId 读当前名单，上传后带 versionId 读新版本名单，
   * 少了任何一个就抛 SecretLossError、不切流量。读不到（未实现/无权限）只告警并跳过校验。
   */
  listSecretNames?(opts: { scriptName: string; versionId?: string }): Promise<string[]>
}

export interface HealthCheckOptions {
  /** 默认 `/healthz` */
  path?: string
  /** 默认 10 次 */
  retries?: number
  /** 默认 2000ms */
  intervalMs?: number
}

export interface DeployOptions {
  api: DeployApi
  scriptName: string
  projection: Projection
  /**
   * 缺省时：有 Durable Object 的 Worker 没有版本预览 URL（平台限制），自动跳过；否则启用。
   * 传对象则强制检查，传 false 跳过。
   */
  healthCheck?: HealthCheckOptions | false
  message?: string
  onProgress?: (step: DeployStep) => void
  /** 健康检查用的 fetch */
  fetchImpl?: typeof fetch
}

export class HealthCheckError extends Error {
  override readonly name = 'HealthCheckError'
  constructor(
    message: string,
    readonly url: string,
    readonly attempts: number,
  ) {
    super(message)
  }
}

/** 保全校验失败：上传后的版本少了这些 secret，说明平台把 binding 丢了；中止 promote，避免无凭证的版本上线 */
export class SecretLossError extends Error {
  override readonly name = 'SecretLossError'
  constructor(
    readonly missing: string[],
  ) {
    super(`上传后的版本丢失 secret：${missing.join('、')}，未切换流量`)
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** 读 secret 名单；失败（方法未实现/无权限/API 报错）只告警并返回 undefined，校验跳过 */
async function tryListSecretNames(
  api: DeployApi,
  opts: { scriptName: string; versionId?: string },
  report: (stage: DeployStep['stage'], message: string) => void,
): Promise<string[] | undefined> {
  try {
    return await api.listSecretNames?.(opts)
  } catch (err) {
    report('upload', `无法读取 secret 名单，跳过保全校验：${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
}

/** 上传版本 → 预览地址健康检查 → 切 100% 流量。健康检查失败不切流量。 */
export async function deploy(opts: DeployOptions): Promise<DeployResult> {
  const { api, scriptName, projection } = opts
  const report = (stage: DeployStep['stage'], message: string) => opts.onProgress?.({ stage, message })

  report('upload', `上传版本 ${projection.hash.slice(0, 8)}（${Object.keys(projection.modules).length} 个模块）`)

  // 保全校验：bindings 是整体替换语义，上传前记录当前生效的 secret 名单，上传后核对原样保留
  const secretsBefore = await tryListSecretNames(api, { scriptName }, report)

  const { versionId } = await api.uploadVersion({
    scriptName,
    projection,
    ...(opts.message !== undefined ? { message: opts.message } : {}),
  })
  report('upload', `版本已上传：${versionId}`)

  if (secretsBefore !== undefined) {
    const secretsAfter = await tryListSecretNames(api, { scriptName, versionId }, report)
    if (secretsAfter !== undefined) {
      const missing = secretsBefore.filter((name) => !secretsAfter.includes(name))
      if (missing.length > 0) throw new SecretLossError(missing)
      report('upload', `secret 保全校验通过（${secretsAfter.length} 个）`)
    }
  }

  const hasDurableObjects = Boolean(projection.metadata.exports && Object.keys(projection.metadata.exports).length)
  let healthCheck: HealthCheckOptions | false
  if (opts.healthCheck === undefined) healthCheck = hasDurableObjects ? false : {}
  else healthCheck = opts.healthCheck

  let previewUrl: string | undefined
  if (healthCheck === false) {
    report('health', opts.healthCheck === undefined && hasDurableObjects ? '含 Durable Object 的 Worker 无预览 URL，跳过健康检查' : '跳过健康检查')
  } else {
    const subdomain = await api.getWorkersSubdomain()
    previewUrl = api.previewUrl({ scriptName, versionId, subdomain })
    const url = previewUrl + (healthCheck.path ?? '/healthz')
    await waitHealthy(url, healthCheck, opts.fetchImpl ?? fetch, (msg) => report('health', msg))
  }

  report('promote', `切换 100% 流量到 ${versionId}`)
  await api.deployVersion({
    scriptName,
    versionId,
    ...(opts.message !== undefined ? { message: opts.message } : {}),
  })
  report('done', `部署完成：${versionId}`)

  return { versionId, hash: projection.hash, ...(previewUrl ? { previewUrl } : {}) }
}

async function waitHealthy(
  url: string,
  opts: HealthCheckOptions,
  fetchImpl: typeof fetch,
  log: (message: string) => void,
): Promise<void> {
  const retries = Math.max(1, opts.retries ?? 10)
  const intervalMs = opts.intervalMs ?? 2000
  let lastError = ''
  for (let attempt = 1; attempt <= retries; attempt++) {
    log(`健康检查 ${url}（${attempt}/${retries}）`)
    try {
      const res = await fetchImpl(url, { method: 'GET', redirect: 'manual' })
      if (res.ok) {
        log(`健康检查通过：HTTP ${res.status}`)
        return
      }
      lastError = `HTTP ${res.status}`
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    if (attempt < retries) await sleep(intervalMs)
  }
  throw new HealthCheckError(`健康检查失败（${retries} 次）：${lastError}，未切换流量`, url, retries)
}
