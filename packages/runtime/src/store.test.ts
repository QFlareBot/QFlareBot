/**
 * 每个请求都要用的两样东西——面板保存的凭证（rt:bot）和 AccessToken（rt:token）——在 isolate 内缓存，
 * 省掉每个请求的 KV 读。要守住的是缓存不能让换号后的请求用上旧凭证、旧 token。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { kvTokenCache, readStoredBotConfig, resetSnapshotCache, writeBotConfig } from './store.js'
import { createKV } from './testing/mocks.js'
import type { RuntimeEnv } from './types.js'

/** 记下每次 KV 读的键 */
function countingEnv() {
  const kv = createKV()
  const reads: string[] = []
  const raw = kv as unknown as { get(key: string, type?: string): Promise<unknown> }
  const get = raw.get.bind(kv)
  raw.get = (key, type) => {
    reads.push(key)
    return get(key, type)
  }
  return { env: { KV: kv } as unknown as RuntimeEnv, kv, reads }
}

const now = () => Math.floor(Date.now() / 1000)

beforeEach(() => resetSnapshotCache())
afterEach(() => vi.useRealTimers())

describe('面板保存的凭证（rt:bot）', () => {
  it('10 秒内只读一次 KV，没配凭证（null）也缓存', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { env, kv, reads } = countingEnv()

    expect(await readStoredBotConfig(env)).toBeNull()
    kv.store.set('rt:bot', JSON.stringify({ appId: '111', secret: 's1' }))
    expect(await readStoredBotConfig(env)).toBeNull()
    expect(reads).toEqual(['rt:bot'])

    vi.setSystemTime(Date.now() + 10_000)
    expect(await readStoredBotConfig(env)).toEqual({ appId: '111', secret: 's1' })
    expect(reads).toEqual(['rt:bot', 'rt:bot'])
    // force 绕过缓存
    await readStoredBotConfig(env, true)
    expect(reads).toHaveLength(3)
  })

  it('writeBotConfig 顺手刷新缓存：保存后本 isolate 立刻用上新凭证，不读 KV', async () => {
    const { env, kv, reads } = countingEnv()
    kv.store.set('rt:bot', JSON.stringify({ appId: '111', secret: 's1' }))
    expect(await readStoredBotConfig(env)).toEqual({ appId: '111', secret: 's1' })

    await writeBotConfig(env, { appId: '222', secret: 's2' })
    expect(await readStoredBotConfig(env)).toEqual({ appId: '222', secret: 's2' })
    expect(reads).toEqual(['rt:bot'])
    expect(JSON.parse(kv.store.get('rt:bot')!)).toEqual({ appId: '222', secret: 's2' })
  })
})

describe('token 的 isolate 内副本', () => {
  it('set 之后 get 直接用内存，不再读 KV；KV 里照样写一份给别的 isolate', async () => {
    const { env, kv, reads } = countingEnv()
    const cache = kvTokenCache(env, '111')
    await cache.set({ token: 't1', expiresAt: now() + 7200 })
    expect(await cache.get()).toEqual({ token: 't1', expiresAt: expect.any(Number) })
    // 每个请求新建一次，同一个号仍然命中内存
    expect(await kvTokenCache(env, '111').get()).toMatchObject({ token: 't1' })
    expect(reads).toEqual([])
    expect(JSON.parse(kv.store.get('rt:token')!)).toMatchObject({ token: 't1', appId: '111' })
  })

  it('从 KV 读到一次后记进内存', async () => {
    const { env, kv, reads } = countingEnv()
    kv.store.set('rt:token', JSON.stringify({ token: 't1', expiresAt: now() + 7200, appId: '111' }))
    await kvTokenCache(env, '111').get()
    await kvTokenCache(env, '111').get()
    expect(reads).toEqual(['rt:token'])
  })

  it('快过期（提前量之内）的不用内存，回头读 KV 拿别的 isolate 换好的', async () => {
    const { env, kv, reads } = countingEnv()
    const cache = kvTokenCache(env, '111')
    await cache.set({ token: 'old', expiresAt: now() + 30 })
    kv.store.set('rt:token', JSON.stringify({ token: 'new', expiresAt: now() + 7200, appId: '111' }))
    expect(await cache.get()).toMatchObject({ token: 'new' })
    expect(reads).toEqual(['rt:token'])
  })

  it('按 AppID 分开：别的号的内存副本、KV 里标着别的号的 token 都不认；老运行时写的没标号照旧认', async () => {
    const { env, kv } = countingEnv()
    await kvTokenCache(env, '111').set({ token: 't111', expiresAt: now() + 7200 })
    expect(await kvTokenCache(env, '222').get()).toBeNull()

    kv.store.set('rt:token', JSON.stringify({ token: 'legacy', expiresAt: now() + 7200 }))
    expect(await kvTokenCache(env, '222').get()).toMatchObject({ token: 'legacy' })
  })

  it('writeBotConfig 换号时清掉内存里的 token', async () => {
    const { env } = countingEnv()
    await kvTokenCache(env, '111').set({ token: 't1', expiresAt: now() + 7200 })
    await writeBotConfig(env, { appId: '111', secret: 'reset' })
    expect(await kvTokenCache(env, '111').get()).toBeNull()
  })

  it('KV 写失败（写额度用完）不抛错，本 isolate 照样用内存里这份', async () => {
    const { env, kv, reads } = countingEnv()
    ;(kv as unknown as { put: () => Promise<void> }).put = async () => {
      throw new Error('KV put() limit exceeded for the day')
    }
    const cache = kvTokenCache(env, '111')
    await expect(cache.set({ token: 't1', expiresAt: now() + 7200 })).resolves.toBeUndefined()
    expect(await cache.get()).toMatchObject({ token: 't1' })
    expect(reads).toEqual([])
  })

  it('invalidate 写进去的空 token 让内存失效', async () => {
    const { env } = countingEnv()
    const cache = kvTokenCache(env, '111')
    await cache.set({ token: 't1', expiresAt: now() + 7200 })
    await cache.set({ token: '', expiresAt: 0 })
    expect(await cache.get()).toMatchObject({ token: '', expiresAt: 0 })
  })
})
