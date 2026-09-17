import { QQApiError } from './errors.js'

export interface CachedToken {
  token: string
  /** Unix 秒 */
  expiresAt: number
}

/** 跨 isolate 共享 token 时由调用方实现（如 KV） */
export interface TokenCache {
  get(): Promise<CachedToken | null>
  set(value: CachedToken): Promise<void>
}

export interface TokenProvider {
  get(): Promise<string>
  /** 强制下次重新获取 */
  invalidate(): Promise<void>
}

export interface TokenProviderOptions {
  appId: string
  secret: string
  cache?: TokenCache
  fetchImpl?: typeof fetch
  tokenUrl?: string
  /** 提前多少秒视为过期，默认 60 */
  skewSeconds?: number
}

export function memoryTokenCache(): TokenCache {
  let value: CachedToken | null = null
  return {
    async get() {
      return value
    },
    async set(v) {
      value = v
    },
  }
}

export function createTokenProvider(options: TokenProviderOptions): TokenProvider {
  const cache = options.cache ?? memoryTokenCache()
  const fetchImpl = options.fetchImpl ?? fetch
  const tokenUrl = options.tokenUrl ?? 'https://api.bot.qq.com/app/getAppAccessToken'
  const skew = options.skewSeconds ?? 60
  // 同一 isolate 内并发请求只发一次网络调用
  let inflight: Promise<string> | null = null

  async function refresh(): Promise<string> {
    const res = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: options.appId, clientSecret: options.secret }),
    })
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number | string }
    if (!res.ok || !data.access_token) {
      throw new QQApiError(res.status, data, '获取 AccessToken 失败，请检查 AppID 与 AppSecret')
    }
    const expiresIn = Number(data.expires_in) || 7200
    await cache.set({ token: data.access_token, expiresAt: Math.floor(Date.now() / 1000) + expiresIn })
    return data.access_token
  }

  return {
    async get() {
      const cached = await cache.get()
      if (cached && cached.expiresAt - skew > Date.now() / 1000) return cached.token
      if (!inflight) {
        inflight = refresh().finally(() => {
          inflight = null
        })
      }
      return inflight
    },
    async invalidate() {
      await cache.set({ token: '', expiresAt: 0 })
    },
  }
}
