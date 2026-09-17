import { definePlugin } from '@qqbot/sdk'
import { getKeyPair, hexToBytes } from '@qqbot/api'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRuntime } from './runtime.js'
import { resetSnapshotCache } from './store.js'
import { resetLifecycle } from './lifecycle.js'
import { cronMatches } from './cron.js'
import {
  createEnv,
  createExecutionContext,
  createQQFetch,
  groupMessagePayload,
  signedRequest,
  TEST_SECRET,
} from './testing/mocks.js'

const BASE = 'https://bot.test'

function makePlugins() {
  const calls: string[] = []
  const installs: string[] = []
  const echo = definePlugin<{ prefix: string }>({
    name: 'echo',
    version: '1.0.0',
    defaultConfig: { prefix: '[echo]' },
    commands: {
      echo: {
        aliases: ['say'],
        async handler({ session, ctx, argText }) {
          calls.push(`echo:${argText}`)
          await session.reply(`${ctx.config.prefix} ${argText}`)
        },
      },
    },
    regex: [
      {
        pattern: '^ping$',
        flags: 'i',
        async handler({ session }) {
          calls.push('regex:ping')
          await session.reply('pong')
        },
      },
    ],
    events: [
      {
        event: 'qq.group.robot_added',
        async handler({ session }) {
          calls.push('event:robot_added')
          await session.send('大家好')
        },
      },
    ],
    hooks: {
      async onInstall() {
        installs.push('echo')
      },
    },
  })

  const guard = definePlugin({
    name: 'guard',
    version: '1.0.0',
    middleware: async ({ session }, next) => {
      calls.push('mw:guard')
      if (session.content.includes('屏蔽')) return
      await next()
    },
  })

  const broken = definePlugin({
    name: 'broken',
    version: '1.0.0',
    commands: {
      echo: {
        priority: 10,
        async handler() {
          calls.push('broken:echo')
          throw new Error('boom')
        },
      },
    },
  })

  const greeter = definePlugin({
    name: 'greeter',
    version: '1.0.0',
    services: { greet: () => (name: string) => `你好，${name}` },
  })

  const consumer = definePlugin({
    name: 'consumer',
    version: '1.0.0',
    depends: { greet: '*' },
    commands: {
      hi: {
        async handler({ session, ctx, argText }) {
          const greet = ctx.service<(n: string) => string>('greet')
          await session.reply(greet(argText))
        },
      },
    },
  })

  return { calls, installs, echo, guard, broken, greeter, consumer }
}

beforeEach(() => {
  resetSnapshotCache()
  resetLifecycle()
})

describe('webhook', () => {
  it('op 13 返回可被派生公钥验证的签名', async () => {
    const runtime = createRuntime({ plugins: [] })
    const env = createEnv()
    const body = { op: 13, d: { plain_token: 'Arq0D5A61EgUu4OxUvOp', event_ts: '1725442341' } }
    const res = await runtime.fetch!(await signedRequest(`${BASE}/webhook`, body), env, createExecutionContext())
    expect(res.status).toBe(200)
    const data = (await res.json()) as { plain_token: string; signature: string }
    expect(data.plain_token).toBe('Arq0D5A61EgUu4OxUvOp')

    const { publicKey } = await getKeyPair(TEST_SECRET)
    const ok = await crypto.subtle.verify(
      { name: 'Ed25519' },
      publicKey,
      hexToBytes(data.signature),
      new TextEncoder().encode('1725442341Arq0D5A61EgUu4OxUvOp'),
    )
    expect(ok).toBe(true)
  })

  it('签名错误、时间戳过期、重复事件分别被拦截', async () => {
    const runtime = createRuntime({ plugins: [] })
    const env = createEnv()
    const payload = groupMessagePayload('hi', 'dup')

    const bad = await runtime.fetch!(await signedRequest(`${BASE}/webhook`, payload, 'wrong-secret'), env, createExecutionContext())
    expect(bad.status).toBe(401)

    const stale = await runtime.fetch!(
      await signedRequest(`${BASE}/webhook`, payload, TEST_SECRET, Math.floor(Date.now() / 1000) - 3600),
      env,
      createExecutionContext(),
    )
    expect(stale.status).toBe(401)

    const first = await runtime.fetch!(await signedRequest(`${BASE}/webhook`, payload), env, createExecutionContext())
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ op: 12 })
    expect(env.KV.store.has('rt:evt:GROUP_AT_MESSAGE_CREATE:dup')).toBe(true)
  })

  it('未配置机器人时返回 503', async () => {
    const runtime = createRuntime({ plugins: [] })
    const env = createEnv({ BOT_APPID: undefined, BOT_SECRET: undefined })
    const res = await runtime.fetch!(await signedRequest(`${BASE}/webhook`, { op: 13, d: {} }), env, createExecutionContext())
    expect(res.status).toBe(503)
  })

  it('事件被分发到命令处理器并通过 OpenAPI 被动回复', async () => {
    const { echo, calls, installs } = makePlugins()
    const qq = createQQFetch()
    const runtime = createRuntime({ plugins: [echo], fetchImpl: qq.fetchImpl })
    const env = createEnv()
    const execCtx = createExecutionContext()

    const res = await runtime.fetch!(await signedRequest(`${BASE}/webhook`, groupMessagePayload('/echo 你好 世界')), env, execCtx)
    expect(res.status).toBe(200)
    await execCtx.flush()

    expect(installs).toEqual(['echo'])
    expect(calls).toEqual(['echo:你好 世界'])
    expect(qq.sent).toHaveLength(1)
    expect(qq.sent[0]!.url).toBe('https://api.sgroup.qq.com/v2/groups/G1/messages')
    expect(qq.sent[0]!.body).toMatchObject({ msg_type: 0, content: '[echo] 你好 世界', msg_seq: 1 })
    expect(String(qq.sent[0]!.body.msg_id)).toMatch(/^ROBOT1\.0_/)
    expect(env.KV.store.get('rt:installed:echo')).toBe('1.0.0')
  })
})

describe('dispatcher（经 /admin/test-event 干跑）', () => {
  async function testEvent(runtime: ReturnType<typeof createRuntime>, env = createEnv(), body: Record<string, unknown>) {
    const res = await runtime.fetch!(
      new Request(`${BASE}/admin/test-event`, {
        method: 'POST',
        headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
      createExecutionContext(),
    )
    expect(res.status).toBe(200)
    return (await res.json()) as {
      matched: Array<{ plugin: string; kind: string; name: string }>
      errors: Array<{ plugin: string; stage: string; message: string }>
      outbox: Array<{ message: unknown; msgSeq?: number }>
    }
  }

  it('高优先级命令先执行，出错被隔离，block 阻止后续命令', async () => {
    const { echo, broken, calls } = makePlugins()
    const runtime = createRuntime({ plugins: [echo, broken] })
    const r = await testEvent(runtime, undefined, { content: '/echo x' })

    expect(calls).toEqual(['broken:echo'])
    expect(r.matched.map((m) => m.plugin)).toEqual(['broken'])
    expect(r.errors).toEqual([{ plugin: 'broken', stage: 'command:echo', message: 'boom' }])
    expect(r.outbox).toEqual([])
  })

  it('别名、正则与事件规则都能命中，配置来自快照', async () => {
    const { echo } = makePlugins()
    const runtime = createRuntime({ plugins: [echo] })
    const env = createEnv()
    env.KV.store.set('rt:snapshot', JSON.stringify({ revision: 1, plugins: { echo: { enabled: true, config: { prefix: '>>' } } } }))

    const alias = await testEvent(runtime, env, { content: '/say hi' })
    expect(alias.outbox[0]).toMatchObject({ message: '>> hi', msgSeq: 1 })

    const regex = await testEvent(runtime, env, { content: 'PING' })
    expect(regex.matched[0]).toMatchObject({ kind: 'regex' })
    expect(regex.outbox[0]).toMatchObject({ message: 'pong' })

    const event = await testEvent(runtime, env, { rawType: 'GROUP_ADD_ROBOT', content: '' })
    expect(event.matched[0]).toMatchObject({ kind: 'event', name: 'qq.group.robot_added' })
    expect(event.outbox[0]).toMatchObject({ message: '大家好' })
    expect(event.outbox[0]!.msgSeq).toBeUndefined()
  })

  it('中间件可以短路，禁用的插件不参与', async () => {
    const { echo, guard, calls } = makePlugins()
    const runtime = createRuntime({ plugins: [guard, echo] })

    const blocked = await testEvent(runtime, undefined, { content: '/echo 屏蔽' })
    expect(calls).toEqual(['mw:guard'])
    expect(blocked.matched).toEqual([])

    const env = createEnv()
    env.KV.store.set('rt:snapshot', JSON.stringify({ revision: 1, plugins: { guard: { enabled: false } } }))
    resetSnapshotCache()
    const passed = await testEvent(runtime, env, { content: '/echo 屏蔽' })
    expect(passed.matched.map((m) => m.plugin)).toEqual(['echo'])
  })

  it('服务由提供者插件注入；提供者禁用时调用方报错', async () => {
    const { greeter, consumer } = makePlugins()
    const runtime = createRuntime({ plugins: [greeter, consumer] })

    const ok = await testEvent(runtime, undefined, { content: '/hi 小明' })
    expect(ok.outbox[0]).toMatchObject({ message: '你好，小明' })

    const env = createEnv()
    env.KV.store.set('rt:snapshot', JSON.stringify({ revision: 1, plugins: { greeter: { enabled: false } } }))
    resetSnapshotCache()
    const failed = await testEvent(runtime, env, { content: '/hi 小明' })
    expect(failed.errors[0]?.message).toContain('未启用')
  })

  it('懒加载条目求值失败只影响自己', async () => {
    const { echo } = makePlugins()
    const runtime = createRuntime({
      plugins: [
        echo,
        { manifest: { ...(await import('@qqbot/sdk')).extractManifest(echo, {}), name: 'bad' }, load: async () => { throw new Error('syntax') } },
      ],
    })
    const r = await testEvent(runtime, undefined, { content: '/echo ok' })
    expect(r.matched.map((m) => m.plugin)).toEqual(['echo'])
    expect(r.outbox).toHaveLength(1)
  })

  it('安全模式跳过所有插件', async () => {
    const { echo } = makePlugins()
    const runtime = createRuntime({ plugins: [echo] })
    const env = createEnv()
    env.KV.store.set('rt:snapshot', JSON.stringify({ revision: 1, plugins: {}, safeMode: true }))
    const r = await testEvent(runtime, env, { content: '/echo x' })
    expect(r.matched).toEqual([])
  })
})

describe('admin', () => {
  it('缺少或错误的 token 被拒绝', async () => {
    const runtime = createRuntime({ plugins: [] })
    const noToken = await runtime.fetch!(new Request(`${BASE}/admin/status`), createEnv({ ADMIN_TOKEN: undefined }), createExecutionContext())
    expect(noToken.status).toBe(403)
    const wrong = await runtime.fetch!(
      new Request(`${BASE}/admin/status`, { headers: { authorization: 'Bearer nope' } }),
      createEnv(),
      createExecutionContext(),
    )
    expect(wrong.status).toBe(401)
  })

  it('PATCH 插件状态写入快照并递增 revision', async () => {
    const { echo } = makePlugins()
    const runtime = createRuntime({ plugins: [echo], projection: 'sha256-abc' })
    const env = createEnv()
    const res = await runtime.fetch!(
      new Request(`${BASE}/admin/plugins/echo`, {
        method: 'PATCH',
        headers: { authorization: 'Bearer admin-token' },
        body: JSON.stringify({ enabled: false, config: { prefix: '!' } }),
      }),
      env,
      createExecutionContext(),
    )
    expect(await res.json()).toMatchObject({ ok: true, revision: 1, state: { enabled: false, config: { prefix: '!' } } })

    const status = await runtime.fetch!(
      new Request(`${BASE}/admin/status`, { headers: { authorization: 'Bearer admin-token' } }),
      env,
      createExecutionContext(),
    )
    expect(await status.json()).toMatchObject({
      projection: 'sha256-abc',
      plugins: [{ name: 'echo', enabled: false, commands: ['echo'] }],
    })
  })

  it('/healthz 无需鉴权', async () => {
    const runtime = createRuntime({ plugins: [], projection: 'sha256-x' })
    const res = await runtime.fetch!(new Request(`${BASE}/healthz`), createEnv(), createExecutionContext())
    expect(await res.json()).toMatchObject({ ok: true, projection: 'sha256-x' })
  })
})

describe('scheduled', () => {
  it('按插件 cron 表达式分发', async () => {
    const ran: string[] = []
    const plugin = definePlugin({
      name: 'timer',
      version: '1.0.0',
      cron: [
        { name: 'hourly', cron: '0 * * * *', handler: async ({ job }) => void ran.push(job) },
        { name: 'noon', cron: '0 12 * * *', handler: async ({ job }) => void ran.push(job) },
      ],
    })
    const runtime = createRuntime({ plugins: [plugin] })
    const at = Date.UTC(2026, 8, 18, 9, 0)
    await runtime.scheduled!({ scheduledTime: at, cron: '* * * * *', noRetry() {} } as ScheduledController, createEnv(), createExecutionContext())
    expect(ran).toEqual(['hourly'])
  })
})

describe('cronMatches', () => {
  it('支持 *、范围、步长与列表', () => {
    const d = new Date(Date.UTC(2026, 8, 18, 9, 30)) // 周五
    expect(cronMatches('30 9 * * *', d)).toBe(true)
    expect(cronMatches('*/15 * * * *', d)).toBe(true)
    expect(cronMatches('0-29/10 9-10 * * 1-5', d)).toBe(false)
    expect(cronMatches('30 9 18 9 5', d)).toBe(true)
    expect(cronMatches('30 9 * * 0,6', d)).toBe(false)
    expect(cronMatches('bad', d)).toBe(false)
  })
})

vi.spyOn(console, 'log').mockImplementation(() => {})
vi.spyOn(console, 'warn').mockImplementation(() => {})
vi.spyOn(console, 'error').mockImplementation(() => {})
