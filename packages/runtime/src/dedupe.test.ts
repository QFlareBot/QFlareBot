import { beforeEach, describe, expect, it } from 'vitest'
import { claimEvent, dedupeSlot, pruneSeenEvents, resetDedupeSchema } from './dedupe.js'
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

describe('去重格子', () => {
  /** 找一个和 base 落在同一格子的 id */
  function collidingWith(base: string): string {
    const slot = dedupeSlot(base)
    for (let i = 0; ; i++) if (dedupeSlot(`c-${i}`) === slot) return `c-${i}`
  }

  it('格子号稳定且在范围内', () => {
    expect(dedupeSlot('GROUP_MESSAGE_CREATE:abc')).toBe(dedupeSlot('GROUP_MESSAGE_CREATE:abc'))
    for (const id of ['', 'a', '中文 id', 'x'.repeat(500)]) {
      expect(dedupeSlot(id)).toBeGreaterThanOrEqual(0)
      expect(dedupeSlot(id)).toBeLessThan(65536)
    }
  })

  it('每个事件只占一个格子，不随事件数增长', async () => {
    const env = { KV: createKV(), DB: createD1() } as unknown as RuntimeEnv & { DB: ReturnType<typeof createD1> }
    for (let i = 0; i < 100; i++) await claimEvent(env, `evt-${i}`, 600)
    await claimEvent(env, 'evt-0', 600)
    expect(env.DB.ring.size).toBeLessThanOrEqual(100)
  })

  it('撞上同一格子时只会重复处理，不会把新事件误判成重复', async () => {
    const env = envWithD1()
    const other = collidingWith('a')
    expect(await claimEvent(env, 'a', 600)).toBe(true)
    expect(await claimEvent(env, other, 600)).toBe(true)
    // a 被挤掉了：它的重投会被当成新事件
    expect(await claimEvent(env, 'a', 600)).toBe(true)
    expect(await claimEvent(env, 'a', 600)).toBe(false)
  })
})

describe('pruneSeenEvents（清升级前的旧去重表）', () => {
  it('删掉超过保留期的行，保留期内的不动', async () => {
    const now = Date.now()
    const db = createD1({ legacySeen: [{ id: 'old', ts: now - 3600_000 }, { id: 'fresh', ts: now }] })
    const env = { KV: createKV(), DB: db } as unknown as RuntimeEnv
    expect(await pruneSeenEvents(env, 600)).toBe(1)
    expect(db.legacySeen).toEqual([{ id: 'fresh', ts: now }])
  })

  it('清空之后不再查', async () => {
    const db = createD1({ legacySeen: [] })
    const env = { KV: createKV(), DB: db } as unknown as RuntimeEnv
    expect(await pruneSeenEvents(env, 600)).toBe(0)
    db.legacySeen!.push({ id: 'late', ts: 0 })
    expect(await pruneSeenEvents(env, 600)).toBe(0)
    expect(db.legacySeen).toHaveLength(1)
  })

  it('新部署没有旧表时是空操作', async () => {
    expect(await pruneSeenEvents(envWithD1(), 600)).toBe(0)
  })

  it('没有 D1 时是空操作', async () => {
    expect(await pruneSeenEvents(envKvOnly(), 600)).toBe(0)
  })
})
