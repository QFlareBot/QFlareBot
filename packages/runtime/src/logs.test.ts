import { beforeEach, describe, expect, it } from 'vitest'
import { dispatchStats, listDispatchLogs, LogsUnavailable, resetLogsCache } from './logs.js'
import type { RuntimeEnv } from './types.js'

const env = { CF_ACCOUNT_ID: 'acc', CF_BUILDS_TOKEN: 'tok', CF_WORKER_NAME: 'mybot' } as unknown as RuntimeEnv

interface Call {
  url: string
  auth: string | null
  body: {
    timeframe: { from: number; to: number }
    view: string
    limit?: number
    parameters: { filters: Array<{ key: string; value: unknown }>; groupBys?: unknown[] }
  }
}

/** 假 telemetry 接口：按调用顺序依次返回 responses 里的结果 */
function telemetry(responses: Array<Record<string, unknown> | Response>) {
  const calls: Call[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      auth: new Headers(init?.headers).get('authorization'),
      body: JSON.parse(String(init?.body)),
    })
    const next = responses.shift() ?? { events: { events: [] } }
    if (next instanceof Response) return next
    return new Response(JSON.stringify({ success: true, result: next }), { status: 200 })
  }) as typeof fetch
  return { fetchImpl, calls }
}

function logEvent(ts: number, data: Record<string, unknown>) {
  return { timestamp: ts, source: { level: 'info', scope: 'runtime', message: '事件已分发', data: { kind: 'dispatch', ...data } } }
}

beforeEach(() => resetLogsCache())

describe('listDispatchLogs', () => {
  it('按 Worker 名与 kind 过滤，日志字段换成 EventRecord（不带正文）', async () => {
    const { fetchImpl, calls } = telemetry([
      {
        events: {
          events: [
            logEvent(2000, {
              id: 'e2',
              event: 'qq.group.message',
              scene: 'group',
              userId: 'U1',
              targetId: 'G1',
              matched: [{ plugin: 'echo', kind: 'command', name: 'echo' }],
              errors: [{ plugin: 'echo', stage: 'command:echo', message: 'boom' }],
              outbox: 1,
              failed: 0,
            }),
            logEvent(1000, { id: 'e1', event: 'qq.group.message' }),
          ],
        },
      },
    ])
    const { events, sampled } = await listDispatchLogs(env, fetchImpl, { limit: 2 })
    expect(calls[0]!.url).toBe('https://api.cloudflare.com/client/v4/accounts/acc/workers/observability/telemetry/query')
    expect(calls[0]!.auth).toBe('Bearer tok')
    expect(calls[0]!.body.parameters.filters).toEqual([
      { key: '$metadata.service', operation: 'eq', type: 'string', value: 'mybot' },
      { key: 'data.kind', operation: 'eq', type: 'string', value: 'dispatch' },
    ])
    expect(sampled).toBe(false)
    expect(events[0]).toEqual({
      id: 'e2',
      ts: 2000,
      event: 'qq.group.message',
      scene: 'group',
      user_id: 'U1',
      target_id: 'G1',
      content: '',
      matched: JSON.stringify([{ plugin: 'echo', kind: 'command', name: 'echo' }]),
      errors: JSON.stringify([{ plugin: 'echo', stage: 'command:echo', message: 'boom' }]),
      outbox: 1,
      failed: 0,
    })
    // 老日志缺的字段按空值补齐
    expect(events[1]).toMatchObject({ id: 'e1', scene: '', matched: '[]', errors: '[]', outbox: 0 })
  })

  it('由近到远三段同时查，段与段不重叠，合并后取最新的 limit 条', async () => {
    const { fetchImpl, calls } = telemetry([
      { events: { events: [logEvent(900, { id: 'a' })] } },
      { events: { events: [logEvent(800, { id: 'b' }), logEvent(700, { id: 'c' })] } },
      { events: { events: [logEvent(100, { id: 'd' })] } },
    ])
    const { events } = await listDispatchLogs(env, fetchImpl, { limit: 3, before: 10_000_000_000 })
    expect(events.map((e) => e.id)).toEqual(['a', 'b', 'c'])
    expect(calls).toHaveLength(3)
    const [first, second, third] = calls.map((c) => c.body)
    // 翻页不带 before 那一条本身
    expect(first!.timeframe.to).toBe(10_000_000_000 - 1)
    expect(second!.timeframe.to).toBe(first!.timeframe.from - 1)
    expect(third!.timeframe.to).toBe(second!.timeframe.from - 1)
    // 最远查到 7 天为止
    expect(first!.timeframe.to + 1 - third!.timeframe.from).toBe(168 * 3600_000)
  })

  it('不翻页时第一段查到此刻', async () => {
    const { fetchImpl, calls } = telemetry([])
    const before = Date.now()
    expect((await listDispatchLogs(env, fetchImpl, { limit: 5 })).events).toEqual([])
    expect(calls[0]!.body.timeframe.to).toBeGreaterThanOrEqual(before)
    expect(calls[0]!.body.timeframe.to - calls[0]!.body.timeframe.from).toBe(3600_000)
  })

  it('只有返回的记录来自被抽样的那段时才标 sampled', async () => {
    const sampledFar = () => ({ events: { events: [logEvent(1, { id: 'old' })] }, statistics: { abr_level: 10 } })
    const enough = telemetry([{ events: { events: [logEvent(900, { id: 'a' })] } }, { events: { events: [] } }, sampledFar()])
    expect(await listDispatchLogs(env, enough.fetchImpl, { limit: 1 })).toMatchObject({ sampled: false, events: [{ id: 'a' }] })
    const short = telemetry([{ events: { events: [] } }, { events: { events: [] } }, sampledFar()])
    expect(await listDispatchLogs(env, short.fetchImpl, { limit: 1 })).toMatchObject({ sampled: true, events: [{ id: 'old' }] })
  })

  it('没配 token、缺权限、接口出错分别给出原因', async () => {
    const reason = (p: Promise<unknown>) => p.then(() => null, (e: LogsUnavailable) => e.reason)
    const noToken = { CF_WORKER_NAME: 'mybot' } as unknown as RuntimeEnv
    expect(await reason(listDispatchLogs(noToken, telemetry([]).fetchImpl))).toBe('no-token')

    const denied = new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }), { status: 403 })
    expect(await reason(listDispatchLogs(env, telemetry([denied]).fetchImpl))).toBe('no-permission')

    const broken = new Response(JSON.stringify({ success: false, errors: [{ code: 1, message: 'bad query' }] }), { status: 400 })
    await expect(listDispatchLogs(env, telemetry([broken]).fetchImpl)).rejects.toThrow('bad query')
  })
})

describe('dispatchStats', () => {
  const calc = (groups: Array<[string, number]>, sampleInterval = 1) => ({
    calculations: [{ aggregates: groups.map(([value, count]) => ({ groups: [{ key: 'data.ok', value }], count, sampleInterval })) }],
  })
  /** 收集 waitUntil 交出去的后台刷新，测试里再等它们跑完 */
  function background() {
    const pending: Array<Promise<unknown>> = []
    return { waitUntil: (p: Promise<unknown>) => void pending.push(p), settle: () => Promise.all(pending.splice(0)) }
  }

  it('按 data.ok 分组计 24 小时事件数与出错数；第一次不等查询，先返回 null', async () => {
    const { fetchImpl, calls } = telemetry([calc([['true', 40], ['false', 2]])])
    const bg = background()
    expect(await dispatchStats(env, fetchImpl, bg.waitUntil)).toBeNull()
    await bg.settle()
    expect(await dispatchStats(env, fetchImpl, bg.waitUntil)).toEqual({ total: 42, last24h: 42, errors24h: 2 })
    expect(calls[0]!.body.view).toBe('calculations')
    expect(calls[0]!.body.parameters.groupBys).toEqual([{ type: 'boolean', value: 'data.ok' }])
  })

  it('被抽样时标成估算值', async () => {
    const { fetchImpl } = telemetry([calc([['true', 3670]], 10)])
    const bg = background()
    await dispatchStats(env, fetchImpl, bg.waitUntil)
    await bg.settle()
    expect(await dispatchStats(env, fetchImpl, bg.waitUntil)).toMatchObject({ last24h: 3670, sampled: true })
  })

  it('缓存一分钟：期间不再查，过期后先给旧值再后台刷新；刷新中不重复发请求', async () => {
    const { fetchImpl, calls } = telemetry([calc([['true', 1]]), calc([['true', 2]])])
    const bg = background()
    await dispatchStats(env, fetchImpl, bg.waitUntil)
    await dispatchStats(env, fetchImpl, bg.waitUntil)
    await bg.settle()
    expect(calls).toHaveLength(1)
    expect((await dispatchStats(env, fetchImpl, bg.waitUntil))?.last24h).toBe(1)
    expect(calls).toHaveLength(1)

    const realNow = Date.now
    Date.now = () => realNow() + 61_000
    try {
      expect((await dispatchStats(env, fetchImpl, bg.waitUntil))?.last24h).toBe(1)
      await bg.settle()
      expect((await dispatchStats(env, fetchImpl, bg.waitUntil))?.last24h).toBe(2)
    } finally {
      Date.now = realNow
    }
  })

  it('查不到时返回 null，也缓存起来不反复打接口', async () => {
    const denied = () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000 }] }), { status: 403 })
    const { fetchImpl, calls } = telemetry([denied(), denied()])
    const bg = background()
    expect(await dispatchStats(env, fetchImpl, bg.waitUntil)).toBeNull()
    await bg.settle()
    expect(await dispatchStats(env, fetchImpl, bg.waitUntil)).toBeNull()
    await bg.settle()
    expect(calls).toHaveLength(1)
    expect(await dispatchStats({ CF_WORKER_NAME: 'x' } as unknown as RuntimeEnv, fetchImpl, bg.waitUntil)).toBeNull()
  })
})
