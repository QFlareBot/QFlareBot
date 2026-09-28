/**
 * token 缓存写失败不能当成致命错误：运行时的缓存是 KV，免费版每天只有 1000 次写入，
 * 额度用完后 cache.set 会抛错——以前这会让取 token 失败，所有消息都发不出去。
 */
import { describe, expect, it, vi } from 'vitest'
import { createTokenProvider, type TokenCache } from './token.js'

const tokenResponse = () => new Response(JSON.stringify({ access_token: 'tok', expires_in: 7200 }))

describe('token 缓存写失败', () => {
  it('refresh 时 cache.set 抛错：照样返回 token', async () => {
    const cache: TokenCache = {
      get: async () => null,
      set: async () => {
        throw new Error('KV put() limit exceeded for the day')
      },
    }
    const provider = createTokenProvider({ appId: 'a', secret: 's', cache, fetchImpl: vi.fn(async () => tokenResponse()) })
    expect(await provider.get()).toBe('tok')
  })

  it('cache.set 同步抛错也兜得住', async () => {
    const cache = {
      get: async () => null,
      set: () => {
        throw new Error('sync')
      },
    } as unknown as TokenCache
    const provider = createTokenProvider({ appId: 'a', secret: 's', cache, fetchImpl: vi.fn(async () => tokenResponse()) })
    expect(await provider.get()).toBe('tok')
    await expect(provider.invalidate()).resolves.toBeUndefined()
  })

  it('invalidate 写失败不抛', async () => {
    const cache: TokenCache = {
      get: async () => ({ token: 'old', expiresAt: Math.floor(Date.now() / 1000) + 3600 }),
      set: async () => {
        throw new Error('KV 挂了')
      },
    }
    const provider = createTokenProvider({ appId: 'a', secret: 's', cache, fetchImpl: vi.fn(async () => tokenResponse()) })
    await expect(provider.invalidate()).resolves.toBeUndefined()
  })
})

describe('并发换 token', () => {
  const empty = (): TokenCache => ({ get: async () => null, set: async () => {} })

  it('同一 AppID 的多个客户端（运行时每个请求新建一个）同时来取，只换一次', async () => {
    const fetchImpl = vi.fn(async () => tokenResponse())
    const a = createTokenProvider({ appId: 'shared', secret: 's', cache: empty(), fetchImpl })
    const b = createTokenProvider({ appId: 'shared', secret: 's', cache: empty(), fetchImpl })
    expect(await Promise.all([a.get(), b.get(), a.get()])).toEqual(['tok', 'tok', 'tok'])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('换完就不再共享：下一次过期照常重新换', async () => {
    const fetchImpl = vi.fn(async () => tokenResponse())
    const a = createTokenProvider({ appId: 'again', secret: 's', cache: empty(), fetchImpl })
    await a.get()
    await a.get()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('不同 AppID 或 secret 各换各的', async () => {
    const fetchImpl = vi.fn(async () => tokenResponse())
    const a = createTokenProvider({ appId: 'x', secret: 's1', cache: empty(), fetchImpl })
    const b = createTokenProvider({ appId: 'y', secret: 's1', cache: empty(), fetchImpl })
    const c = createTokenProvider({ appId: 'x', secret: 's2', cache: empty(), fetchImpl })
    await Promise.all([a.get(), b.get(), c.get()])
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })
})
