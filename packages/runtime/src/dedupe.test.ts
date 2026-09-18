import { beforeEach, describe, expect, it } from 'vitest'
import { claimEvent, pruneSeenEvents, resetDedupeSchema } from './dedupe.js'
import { createD1, createKV } from './testing/mocks.js'
import type { RuntimeEnv } from './types.js'

function envWithD1(): RuntimeEnv {
  return { KV: createKV(), DB: createD1() } as unknown as RuntimeEnv
}
function envKvOnly(): RuntimeEnv {
  return { KV: createKV() } as unknown as RuntimeEnv
}

beforeEach(() => resetDedupeSchema())

describe('claimEvent（D1 路径）', () => {
  it('首次返回 true，重复返回 false', async () => {
    const env = envWithD1()
    expect(await claimEvent(env, 'evt-1', 600)).toBe(true)
    expect(await claimEvent(env, 'evt-1', 600)).toBe(false)
    expect(await claimEvent(env, 'evt-1', 600)).toBe(false)
  })

  it('不同 id 互不影响', async () => {
    const env = envWithD1()
    expect(await claimEvent(env, 'a', 600)).toBe(true)
    expect(await claimEvent(env, 'b', 600)).toBe(true)
    expect(await claimEvent(env, 'a', 600)).toBe(false)
  })

  it('并发声明同一 id 只有一个成功——这正是 KV 的 get-then-put 给不了的', async () => {
    const env = envWithD1()
    const results = await Promise.all(Array.from({ length: 8 }, () => claimEvent(env, 'race', 600)))
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it('D1 抛错时降级到 KV，不把事件丢掉', async () => {
    const env = {
      KV: createKV(),
      DB: { exec: async () => ({ count: 0, duration: 0 }), prepare: () => ({ bind: () => ({ run: async () => { throw new Error('D1 挂了') } }) }) },
    } as unknown as RuntimeEnv
    expect(await claimEvent(env, 'evt-1', 600)).toBe(true)
    // 降级后走 KV，仍然能去重
    expect(await claimEvent(env, 'evt-1', 600)).toBe(false)
  })
})

describe('claimEvent（无 D1 时的 KV 降级）', () => {
  it('仍然能去重', async () => {
    const env = envKvOnly()
    expect(await claimEvent(env, 'evt-1', 600)).toBe(true)
    expect(await claimEvent(env, 'evt-1', 600)).toBe(false)
  })

  it('ttl 低于 60 秒时抬到 KV 允许的下限', async () => {
    const env = envKvOnly()
    await claimEvent(env, 'evt-1', 5)
    expect(await env.KV.get('rt:evt:evt-1')).toBe('1')
  })
})

describe('pruneSeenEvents', () => {
  it('删掉超过保留期的行，保留期内的不动', async () => {
    const env = envWithD1()
    await claimEvent(env, 'old', 600)
    await claimEvent(env, 'fresh', 600)
    // 保留期 0 会被抬到 60 秒，此时两行都还很新
    expect(await pruneSeenEvents(env, 600)).toBe(0)
    expect(await claimEvent(env, 'old', 600)).toBe(false)
  })

  it('没有 D1 时是空操作', async () => {
    expect(await pruneSeenEvents(envKvOnly(), 600)).toBe(0)
  })
})
