import type { Logger } from '@qqbot/sdk'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearEvents, listEvents, LIVE_SLOTS, recordEvent, resetEventsSchema, setLiveDebug, type RecordInput } from './events.js'
import { createD1, createKV } from './testing/mocks.js'
import type { RuntimeEnv } from './types.js'

const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger

function input(id: string, content = `msg ${id}`): RecordInput {
  return {
    id,
    event: 'qq.group.message',
    scene: 'group',
    userId: 'U1',
    targetId: 'G1',
    content,
    report: { matched: [], errors: [] },
    outbox: 0,
    failed: 0,
  }
}

function envWithD1() {
  return { KV: createKV(), DB: createD1() } as unknown as RuntimeEnv & { DB: ReturnType<typeof createD1> }
}

beforeEach(() => resetEventsSchema())

describe('实时调试记录', () => {
  it('没开实时调试时一行不写', async () => {
    const env = envWithD1()
    await recordEvent(env, input('e1'), logger)
    expect(env.DB.rows).toHaveLength(0)
    expect(env.DB.live.seq).toBe(0)
    expect(await listEvents(env)).toEqual([])
  })

  it('开着时记下正文（截到 200 字），新的在前', async () => {
    const env = envWithD1()
    await setLiveDebug(env, true)
    await recordEvent(env, input('e1', 'x'.repeat(300)), logger)
    await recordEvent(env, input('e2'), logger)
    const events = await listEvents(env)
    expect(events.map((e) => e.id)).toEqual(['e2', 'e1'])
    expect(events[1]!.content).toHaveLength(200)
    expect(events[0]).toMatchObject({ scene: 'group', user_id: 'U1', target_id: 'G1', matched: '[]', errors: '[]' })
  })

  it(`最多留 ${LIVE_SLOTS} 条，满了覆盖最老的`, async () => {
    const env = envWithD1()
    await setLiveDebug(env, true)
    for (let i = 1; i <= LIVE_SLOTS + 3; i++) await recordEvent(env, input(`e${i}`), logger)
    expect(env.DB.rows).toHaveLength(LIVE_SLOTS)
    const ids = (await listEvents(env)).map((e) => e.id)
    expect(ids[0]).toBe(`e${LIVE_SLOTS + 3}`)
    expect(ids.at(-1)).toBe('e4')
  })

  it('关掉或过期之后不再写', async () => {
    const env = envWithD1()
    expect(await setLiveDebug(env, true)).toBeGreaterThan(Date.now())
    await recordEvent(env, input('e1'), logger)
    expect(await setLiveDebug(env, false)).toBe(0)
    await recordEvent(env, input('e2'), logger)
    expect((await listEvents(env)).map((e) => e.id)).toEqual(['e1'])

    // 面板停了续期：开关自己过期
    await setLiveDebug(env, true)
    env.DB.live.until = Date.now() - 1
    await recordEvent(env, input('e3'), logger)
    expect((await listEvents(env)).map((e) => e.id)).toEqual(['e1'])
  })

  it('清空只删记录，不动开关', async () => {
    const env = envWithD1()
    await setLiveDebug(env, true)
    await recordEvent(env, input('e1'), logger)
    await clearEvents(env)
    expect(await listEvents(env)).toEqual([])
    await recordEvent(env, input('e2'), logger)
    expect((await listEvents(env)).map((e) => e.id)).toEqual(['e2'])
  })

  it('没有 D1 时开不了', async () => {
    const env = { KV: createKV() } as unknown as RuntimeEnv
    expect(await setLiveDebug(env, true)).toBeNull()
    expect(await listEvents(env)).toEqual([])
  })
})
