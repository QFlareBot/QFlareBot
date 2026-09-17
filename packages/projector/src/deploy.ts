import type { DeployResult, DeployStep, Projection } from './types.js'

/** deploy 只依赖这几个方法，便于测试时注入假实现 */
export interface DeployApi {
  uploadVersion(opts: { scriptName: string; projection: Projection; message?: string }): Promise<{ versionId: string }>
  deployVersion(opts: { scriptName: string; versionId: string; message?: string }): Promise<unknown>
  getWorkersSubdomain(): Promise<string>
  previewUrl(opts: { scriptName: string; versionId: string; subdomain: string }): string
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** 上传版本 → 预览地址健康检查 → 切 100% 流量。健康检查失败不切流量。 */
export async function deploy(opts: DeployOptions): Promise<DeployResult> {
  const { api, scriptName, projection } = opts
  const report = (stage: DeployStep['stage'], message: string) => opts.onProgress?.({ stage, message })

  report('upload', `上传版本 ${projection.hash.slice(0, 8)}（${Object.keys(projection.modules).length} 个模块）`)
  const { versionId } = await api.uploadVersion({
    scriptName,
    projection,
    ...(opts.message !== undefined ? { message: opts.message } : {}),
  })
  report('upload', `版本已上传：${versionId}`)

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
