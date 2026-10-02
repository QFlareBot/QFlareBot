import { apiErrorCode, isMarkdownDenied } from './errors.js'

/** 一次发送（包括上传、鉴权刷新和降级）共用预算，为 webhook 收尾留出时间。 */
export const REQUEST_BUDGET_MS = 20_000
const ATTEMPT_TIMEOUT_MS = 8_000
const RETRY_DELAY_MS = 250
const TRANSIENT_CODES = new Set([50001, 11281, 11252, 11263, 11242])

export interface JsonResponse<T = unknown> {
  status: number
  data: T
  traceId?: string
}

class RequestTimeoutError extends Error {
  constructor() {
    super('QQ API 请求超时')
    this.name = 'TimeoutError'
  }
}

/**
 * 请求头工厂也在超时范围内：token/KV 卡住时仍能结束请求。
 * 只对调用方确认可重复的操作重试一次；401 可额外刷新一次凭证。
 */
export async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit | ((refreshToken: boolean) => Promise<RequestInit>),
  options: { retry?: boolean; refreshToken?: boolean; deadline?: number } = {},
): Promise<JsonResponse> {
  const deadline = options.deadline ?? Date.now() + REQUEST_BUDGET_MS
  let retried = false
  let refreshed = false
  let refreshToken = false

  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new RequestTimeoutError()
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let response: JsonResponse | undefined
    try {
      const refresh = refreshToken
      refreshToken = false
      response = await Promise.race([
        (async (): Promise<JsonResponse> => {
          const request = typeof init === 'function' ? await init(refresh) : init
          // 等待共享 token 的请求可能已经超时，不能在它稍后完成时补发。
          controller.signal.throwIfAborted()
          const res = await fetchImpl(url, { ...request, signal: controller.signal })
          const text = await res.text()
          let data: unknown = null
          if (text) {
            try {
              data = JSON.parse(text)
            } catch {
              data = { raw: text }
            }
          }
          const traceId = res.headers.get('x-tps-trace-id')
          return { status: res.status, data, ...(traceId ? { traceId } : {}) }
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const error = new RequestTimeoutError()
            controller.abort(error)
            reject(error)
          }, Math.min(ATTEMPT_TIMEOUT_MS, remaining))
        }),
      ])
    } catch (error) {
      const transient = error instanceof TypeError || error instanceof RequestTimeoutError ||
        (error instanceof Error && error.name === 'AbortError')
      if (!options.retry || retried || !transient) throw error
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }

    if (response) {
      if (response.status === 401 && options.refreshToken && !refreshed) {
        refreshed = true
        refreshToken = true
        continue
      }
      const code = apiErrorCode(response.data)
      const transient = code === undefined || code === 0
        ? [500, 502, 503, 504].includes(response.status) && !isMarkdownDenied(response.data)
        : TRANSIENT_CODES.has(code)
      if (!options.retry || retried || !transient) return response
    }

    retried = true
    if (deadline - Date.now() <= RETRY_DELAY_MS) {
      if (response) return response
      throw new RequestTimeoutError()
    }
    await new Promise<void>((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
  }
}
