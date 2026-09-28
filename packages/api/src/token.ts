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

/**
 * 正在进行的换 token，整个 isolate 共享，按 AppID（连同 secret、地址）分开：同一 isolate 内并发请求只发一次网络调用。
 * 运行时每个请求都新建客户端，挂在实例上的话管不到别的请求，token 过期那一刻同时进来的几个请求会各自去换、各自写一次缓存
 */
const inflight = new Map<string, Promise<string>>()

export function createTokenProvider(options: TokenProviderOptions): TokenProvider {
  const cache = options.cache ?? memoryTokenCache()
  const fetchImpl = options.fetchImpl ?? fetch
  const tokenUrl = options.tokenUrl ?? 'https://api.bot.qq.com/app/getAppAccessToken'
  const skew = options.skewSeconds ?? 60
  const key = `${tokenUrl}\n${options.appId}\n${options.secret}`

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
    try {
      await cache.set({ token: data.access_token, expiresAt: Math.floor(Date.now() / 1000) + expiresIn })
    } catch {
      // 缓存写失败（比如 KV 当天的写额度用完）不能连累这次取 token：token 已经到手，
      // 抛出去的话所有消息都发不出去；没缓存上顶多下次再换一个
    }
    return data.access_token
  }

  return {
    async get() {
      const cached = await cache.get()
      if (cached && cached.expiresAt - skew > Date.now() / 1000) return cached.token
      let task = inflight.get(key)
      if (!task) {
        task = refresh().finally(() => inflight.delete(key))
        inflight.set(key, task)
      }
      return task
    },
    async invalidate() {
      try {
        await cache.set({ token: '', expiresAt: 0 })
      } catch {
        // 作废没写进去只是下次还拿旧 token 撞一次 401，不该让调用方（发消息）跟着抛错
      }
    },
  }
}
