import { definePlugin } from '@qqbot/sdk'
import { getKeyPair, hexToBytes } from '@qqbot/api'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRuntime } from './runtime.js'
import { buildSession } from './session.js'
import { parseBareCommand, parseCommand } from './dispatcher.js'
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

  it('签名错误与时间戳过期被拦截', async () => {
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
  })

  it('同一事件投递两次只分发一次，第二次照样 ACK', async () => {
    const { echo, calls } = makePlugins()
    const qq = createQQFetch()
    const runtime = createRuntime({ plugins: [echo], fetchImpl: qq.fetchImpl })
    const env = createEnv()
    const payload = groupMessagePayload('/echo 重复', 'dup')

    for (const _ of [1, 2]) {
      const execCtx = createExecutionContext()
      const res = await runtime.fetch!(await signedRequest(`${BASE}/webhook`, payload), env, execCtx)
      // 重复事件也要回 ACK，否则 QQ 会继续重投
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ op: 12 })
      await execCtx.flush()
    }

    expect(calls).toEqual(['echo:重复'])
    expect(qq.sent).toHaveLength(1)
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
    expect(qq.sent[0]!.url).toBe('https://api.bot.qq.com/v2/groups/G1/messages')
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
      session: { event: string; scene: string; canReply: boolean; interaction: { type: string; buttonId: string } | null }
      matched: Array<{ plugin: string; kind: string; name: string }>
      errors: Array<{ plugin: string; stage: string; message: string }>
      outbox: Array<{ target: { scene: string; id: string }; message: unknown; options?: { messageId?: string; eventId?: string; msgSeq?: number } }>
      acks: Array<{ interactionId: string; code: number }>
      recalls: string[]
      streams: Array<{ index: number; content: string; final: boolean }>
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
    expect(alias.outbox[0]).toMatchObject({ message: '>> hi', options: { msgSeq: 1 } })

    const regex = await testEvent(runtime, env, { content: 'PING' })
    expect(regex.matched[0]).toMatchObject({ kind: 'regex' })
    expect(regex.outbox[0]).toMatchObject({ message: 'pong' })

    const event = await testEvent(runtime, env, { rawType: 'GROUP_ADD_ROBOT', content: '' })
    expect(event.matched[0]).toMatchObject({ kind: 'event', name: 'qq.group.robot_added' })
    expect(event.outbox[0]).toMatchObject({ message: '大家好' })
    expect(event.outbox[0]!.options).toBeUndefined()
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


describe('交互与扩展能力（干跑）', () => {
  async function testEvent(runtime: ReturnType<typeof createRuntime>, env = createEnv(), body: Record<string, unknown>) {
    const res = await runtime.fetch!(
      new Request(`${BASE}/admin/test-event`, {
        method: 'POST',
        headers: { authorization: 'Bearer admin-token' },
        body: JSON.stringify(body),
      }),
      env,
      createExecutionContext(),
    )
    return (await res.json()) as {
      session: { event: string; scene: string; canReply: boolean; interaction: { type: string; buttonId: string } | null }
      matched: Array<{ plugin: string; kind: string; name: string }>
      errors: Array<{ plugin: string; stage: string; message: string }>
      outbox: Array<{ target: { scene: string; id: string }; message: unknown; options?: { messageId?: string; eventId?: string; msgSeq?: number } }>
      acks: Array<{ interactionId: string; code: number }>
      recalls: string[]
      streams: Array<{ index: number; content: string; final: boolean }>
    }
  }

  const panel = definePlugin({
    name: 'panel',
    version: '1.0.0',
    buttons: {
      confirm: {
        dataPattern: '^order:',
        async handler({ session, buttonData }) {
          await session.reply(`已确认 ${buttonData}`)
        },
      },
      deny: { async handler() { return 4 } },
      manual: {
        async handler({ interaction, session }) {
          await interaction.ack(3)
          await session.reply('手动 ack')
        },
      },
    },
    events: [
      {
        event: 'qq.group.robot_added',
        async handler({ session }) {
          await session.reply('感谢邀请（event_id 被动回复）')
        },
      },
    ],
    commands: {
      quote: { async handler({ session }) { await session.reply({ text: '引用你', quote: true }) } },
      undo: {
        async handler({ session }) {
          await session.reply('先发一条')
          await session.recall()
        },
      },
      stream: {
        async handler({ session }) {
          const w = session.stream()
          await w.write('你')
          await w.end('好')
        },
      },
    },
  })

  it('按键点击：识别场景与用户、匹配 buttons、处理器未 ack 时自动以 0 回应', async () => {
    const runtime = createRuntime({ plugins: [panel] })
    const r = await testEvent(runtime, undefined, { buttonId: 'confirm', buttonData: 'order:42', scene: 'group', targetId: 'G9', userId: 'U9' })
    expect(r.session).toMatchObject({ event: 'qq.interaction', scene: 'group', canReply: true, interaction: { type: 'button', buttonId: 'confirm' } })
    expect(r.matched).toEqual([{ plugin: 'panel', kind: 'button', name: 'confirm' }])
    expect(r.outbox[0]).toMatchObject({ target: { scene: 'group', id: 'G9' }, message: '已确认 order:42', options: { msgSeq: 1 } })
    expect(r.outbox[0]!.options!.eventId).toMatch(/^INTERACTION_CREATE:/)
    expect(r.outbox[0]!.options!.messageId).toBeUndefined()
    expect(r.acks).toEqual([{ interactionId: expect.any(String), code: 0 }])
  })

  it('dataPattern 不匹配不命中，但仍自动 ack；返回值作为 code；手动 ack 不重复', async () => {
    const runtime = createRuntime({ plugins: [panel] })
    const miss = await testEvent(runtime, undefined, { buttonId: 'confirm', buttonData: 'other' })
    expect(miss.matched).toEqual([])
    expect(miss.acks.map((a) => a.code)).toEqual([0])

    const deny = await testEvent(runtime, undefined, { buttonId: 'deny', scene: 'c2c', userId: 'U1' })
    expect(deny.session.scene).toBe('c2c')
    expect(deny.acks.map((a) => a.code)).toEqual([4])

    const manual = await testEvent(runtime, undefined, { buttonId: 'manual' })
    expect(manual.acks.map((a) => a.code)).toEqual([3])
    expect(manual.outbox).toHaveLength(1)
  })

  it('GROUP_ADD_ROBOT 等事件可用 event_id 被动回复', async () => {
    const runtime = createRuntime({ plugins: [panel] })
    const r = await testEvent(runtime, undefined, { rawType: 'GROUP_ADD_ROBOT', content: '' })
    expect(r.session.canReply).toBe(true)
    expect(r.outbox[0]!.options).toMatchObject({ eventId: expect.stringMatching(/^GROUP_ADD_ROBOT:/), msgSeq: 1 })
  })

  it('quote: true 解析为 message_scene.ext 里的 msg_idx；无 msg_idx 时静默去掉', async () => {
    const runtime = createRuntime({ plugins: [panel] })
    const withRef = await testEvent(runtime, undefined, { content: '/quote', raw: { message_scene: { ext: ['msg_idx=REFIDX_abc', 'auth_token=x'] } } })
    expect(withRef.outbox[0]!.message).toEqual({ text: '引用你', quote: 'REFIDX_abc' })
    const noRef = await testEvent(runtime, undefined, { content: '/quote' })
    expect(noRef.outbox[0]!.message).toEqual({ text: '引用你' })
  })

  it('recall 默认撤回最后一条成功发送的消息', async () => {
    const runtime = createRuntime({ plugins: [panel] })
    const r = await testEvent(runtime, undefined, { content: '/undo' })
    expect(r.recalls).toEqual(['dry-run-1'])
  })

  it('stream：单聊分片下发，群聊退化为一次性回复', async () => {
    const runtime = createRuntime({ plugins: [panel] })
    const c2c = await testEvent(runtime, undefined, { content: '/stream', scene: 'c2c', userId: 'U1' })
    expect(c2c.streams).toEqual([{ index: 0, content: '你', final: false }, { index: 1, content: '好', final: true }])
    expect(c2c.outbox).toEqual([])
    const group = await testEvent(runtime, undefined, { content: '/stream' })
    expect(group.streams).toEqual([])
    expect(group.outbox[0]!.message).toBe('你好')
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
      // installed=false：仓库内置插件，面板不显示卸载入口（改 qqbot.manifest.json 重新构建才下架）
      plugins: [{ name: 'echo', enabled: false, installed: false, commands: [{ name: 'echo', aliases: ['say'] }] }],
    })
  })

  describe('按群生效范围', () => {
    const headers = { authorization: 'Bearer admin-token', 'content-type': 'application/json' }
    const patch = (runtime: ReturnType<typeof createRuntime>, env: ReturnType<typeof createEnv>, groups: unknown) =>
      runtime.fetch!(
        new Request(`${BASE}/admin/plugins/echo`, { method: 'PATCH', headers, body: JSON.stringify({ groups }) }),
        env,
        createExecutionContext(),
      )
    const send = async (runtime: ReturnType<typeof createRuntime>, env: ReturnType<typeof createEnv>, body: Record<string, unknown>) => {
      const res = await runtime.fetch!(
        new Request(`${BASE}/admin/test-event`, { method: 'POST', headers, body: JSON.stringify(body) }),
        env,
        createExecutionContext(),
      )
      return ((await res.json()) as { matched: unknown[] }).matched
    }

    it('allow 只在列出的群生效，单聊不受影响；群 ID 去空白去重', async () => {
      const { echo } = makePlugins()
      const runtime = createRuntime({ plugins: [echo] })
      const env = createEnv()
      const res = await patch(runtime, env, { mode: 'allow', ids: [' G1 ', 'G1', ''] })
      expect(await res.json()).toMatchObject({ ok: true, state: { groups: { mode: 'allow', ids: ['G1'] } } })

      expect(await send(runtime, env, { targetId: 'G1', content: '/echo hi' })).toHaveLength(1)
      expect(await send(runtime, env, { targetId: 'G2', content: '/echo hi' })).toEqual([])
      expect(await send(runtime, env, { scene: 'c2c', targetId: 'U1', content: '/echo hi' })).toHaveLength(1)
    })

    it('deny 在列出的群不生效；groups: null 恢复所有群', async () => {
      const { echo } = makePlugins()
      const runtime = createRuntime({ plugins: [echo] })
      const env = createEnv()
      await patch(runtime, env, { mode: 'deny', ids: ['G1'] })
      expect(await send(runtime, env, { targetId: 'G1', content: 'ping' })).toEqual([])
      expect(await send(runtime, env, { targetId: 'G2', content: 'ping' })).toHaveLength(1)

      const cleared = await patch(runtime, env, null)
      expect(((await cleared.json()) as { state: Record<string, unknown> }).state).not.toHaveProperty('groups')
      expect(await send(runtime, env, { targetId: 'G1', content: 'ping' })).toHaveLength(1)
    })

    it('格式不对的 groups 返回 400，快照不变', async () => {
      const { echo } = makePlugins()
      const runtime = createRuntime({ plugins: [echo] })
      const env = createEnv()
      for (const bad of [{ mode: 'only', ids: ['G1'] }, { mode: 'allow' }, { mode: 'allow', ids: [1] }, 'G1']) {
        expect((await patch(runtime, env, bad)).status).toBe(400)
      }
      expect(await send(runtime, env, { targetId: 'G1', content: '/echo hi' })).toHaveLength(1)
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

describe('语法糖：返回值即回复', () => {
  async function testEvent(runtime: ReturnType<typeof createRuntime>, body: Record<string, unknown>) {
    const res = await runtime.fetch!(
      new Request(`${BASE}/admin/test-event`, { method: 'POST', headers: { authorization: 'Bearer admin-token' }, body: JSON.stringify(body) }),
      createEnv(),
      createExecutionContext(),
    )
    return (await res.json()) as { matched: Array<{ kind: string; name: string }>; outbox: Array<{ message: unknown; options?: { msgSeq?: number; eventId?: string } }>; acks: Array<{ code: number }> }
  }
  const sugar = definePlugin<{ n: number }>({
    name: 'sugar',
    version: '1.0.0',
    defaultConfig: { n: 3 },
    commands: {
      hi: ({ argText }) => `你好 ${argText}`,
      pic: () => ({ image: { url: 'https://x/a.png' } }),
      async *count({ ctx }) {
        for (let i = 1; i <= ctx.config.n; i++) yield `${i}`
      },
      quiet: () => undefined,
    },
    regex: { '/^ping$/i': () => 'pong', '^echo (.+)$': ({ match }) => match[1]! },
    events: { 'qq.group.robot_added': () => '欢迎' },
    buttons: { ok: ({ buttonData }) => `确认 ${buttonData}`, no: () => 4 },
  })

  it('字符串、对象、生成器、undefined 四种返回值', async () => {
    const runtime = createRuntime({ plugins: [sugar] })
    expect((await testEvent(runtime, { content: '/hi 世界' })).outbox.map((o) => o.message)).toEqual(['你好 世界'])
    expect((await testEvent(runtime, { content: '/pic' })).outbox[0]!.message).toEqual({ image: { url: 'https://x/a.png' } })
    const gen = await testEvent(runtime, { content: '/count' })
    expect(gen.outbox.map((o) => [o.message, o.options!.msgSeq])).toEqual([['1', 1], ['2', 2], ['3', 3]])
    expect((await testEvent(runtime, { content: '/quiet' })).outbox).toEqual([])
  })

  it('regex 记录式（含 flags）、events 记录式、buttons 返回消息或 code', async () => {
    const runtime = createRuntime({ plugins: [sugar] })
    expect((await testEvent(runtime, { content: 'PING' })).outbox[0]!.message).toBe('pong')
    expect((await testEvent(runtime, { content: 'echo 回声' })).outbox[0]!.message).toBe('回声')
    const ev = await testEvent(runtime, { rawType: 'GROUP_ADD_ROBOT' })
    expect(ev.outbox[0]).toMatchObject({ message: '欢迎', options: { eventId: expect.stringMatching(/^GROUP_ADD_ROBOT:/) } })
    const ok = await testEvent(runtime, { buttonId: 'ok', buttonData: '1' })
    expect(ok.outbox[0]!.message).toBe('确认 1')
    expect(ok.acks.map((a) => a.code)).toEqual([0])
    const no = await testEvent(runtime, { buttonId: 'no' })
    expect(no.outbox).toEqual([])
    expect(no.acks.map((a) => a.code)).toEqual([4])
  })
})

describe('无前缀命令（bare）', () => {
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
      outbox: Array<{ message: unknown }>
    }
  }

  function makeBarePlugins() {
    const calls: string[] = []
    const bare = definePlugin({
      name: 'bare',
      version: '1.0.0',
      commands: {
        sign: {
          bare: true,
          async handler({ argText }) {
            calls.push(`sign:${argText}`)
            return '已签到'
          },
        },
        echo: {
          async handler({ argText }) {
            calls.push(`echo:${argText}`)
            return `echo ${argText}`
          },
        },
      },
    })
    return { calls, bare }
  }

  it('@ 机器人（at_message）与单聊时普通命令也免前缀', async () => {
    const { bare, calls } = makeBarePlugins()
    const runtime = createRuntime({ plugins: [bare] })

    const at = await testEvent(runtime, undefined, { content: 'echo 你好' })
    expect(at.matched).toEqual([{ plugin: 'bare', kind: 'command', name: 'echo' }])
    expect(at.outbox[0]!.message).toBe('echo 你好')

    const c2c = await testEvent(runtime, undefined, { scene: 'c2c', targetId: 'U1', content: 'echo 在吗' })
    expect(c2c.outbox[0]!.message).toBe('echo 在吗')
    expect(calls).toEqual(['echo:你好', 'echo:在吗'])
  })

  it('群全量消息没 @ 机器人：只有 bare 命令按首词命中', async () => {
    const { bare, calls } = makeBarePlugins()
    const runtime = createRuntime({ plugins: [bare] })

    const hit = await testEvent(runtime, undefined, { rawType: 'GROUP_MESSAGE_CREATE', content: 'sign 早起' })
    expect(hit.matched).toEqual([{ plugin: 'bare', kind: 'command', name: 'sign' }])
    expect(hit.outbox[0]!.message).toBe('已签到')
    expect(calls).toEqual(['sign:早起'])

    const miss = await testEvent(runtime, undefined, { rawType: 'GROUP_MESSAGE_CREATE', content: 'echo 你好' })
    expect(miss.matched).toEqual([])
    expect(miss.outbox).toEqual([])

    // 带前缀照常命中
    expect(
      (await testEvent(runtime, undefined, { rawType: 'GROUP_MESSAGE_CREATE', content: '/echo 你好' })).outbox[0]!.message,
    ).toBe('echo 你好')
  })

  it('群全量消息按 is_you 认 @：@ 本机器人免前缀，@ 别的机器人不算', async () => {
    const { bare } = makeBarePlugins()
    const runtime = createRuntime({ plugins: [bare] })

    const me = await testEvent(runtime, undefined, {
      rawType: 'GROUP_MESSAGE_CREATE',
      content: '<@A1B2C3> echo 你好',
      raw: { mentions: [{ id: 'A1B2C3', username: '本机器人', bot: true, is_you: true }] },
    })
    expect(me.outbox[0]!.message).toBe('echo 你好')

    const other = await testEvent(runtime, undefined, {
      rawType: 'GROUP_MESSAGE_CREATE',
      content: '<@D4E5F6> echo 你好',
      raw: { mentions: [{ id: 'D4E5F6', username: '别的机器人', bot: true, is_you: false }] },
    })
    expect(other.matched).toEqual([])
  })

  it('bare 命令带前缀调用同样命中，命令词大小写不敏感', async () => {
    const { bare } = makeBarePlugins()
    const runtime = createRuntime({ plugins: [bare] })
    expect((await testEvent(runtime, undefined, { content: '/sign' })).outbox[0]!.message).toBe('已签到')
    expect((await testEvent(runtime, undefined, { content: 'SIGN' })).outbox[0]!.message).toBe('已签到')
  })

  it('bare 命令受 scenes 限制', async () => {
    const c2cOnly = definePlugin({
      name: 'c2conly',
      version: '1.0.0',
      commands: { sign: { bare: true, scenes: ['c2c'], handler: () => '已签到' } },
    })
    const runtime = createRuntime({ plugins: [c2cOnly] })
    expect((await testEvent(runtime, undefined, { content: 'sign' })).matched).toEqual([])
    expect(
      (await testEvent(runtime, undefined, { scene: 'c2c', targetId: 'U1', content: 'sign' })).outbox[0]!.message,
    ).toBe('已签到')
  })
})

describe('子命令（命令名带空格）', () => {
  async function testEvent(runtime: ReturnType<typeof createRuntime>, body: Record<string, unknown>) {
    const res = await runtime.fetch!(
      new Request(`${BASE}/admin/test-event`, {
        method: 'POST',
        headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      createEnv(),
      createExecutionContext(),
    )
    return (await res.json()) as { matched: Array<{ plugin: string; name: string }> }
  }

  function makePixiv() {
    const calls: Array<{ name: string; command: string; args: string[]; argText: string }> = []
    const record =
      (name: string) =>
      ({ command, args, argText }: { command: string; args: string[]; argText: string }) => {
        calls.push({ name, command, args, argText })
        return name
      }
    const pixiv = definePlugin({
      name: 'pixiv',
      version: '1.0.0',
      commands: {
        pixiv: record('pixiv'),
        'pixiv random': record('pixiv random'),
        'pixiv illust': { permission: 'bot_admin', handler: record('pixiv illust') },
      },
    })
    return { pixiv, calls }
  }

  it('最长的命令名胜出；参数从子命令后面开始，原文保留换行', async () => {
    const { pixiv, calls } = makePixiv()
    const runtime = createRuntime({ plugins: [pixiv] })

    expect((await testEvent(runtime, { content: '/pixiv random 大图' })).matched).toEqual([
      { plugin: 'pixiv', kind: 'command', name: 'pixiv random' },
    ])
    await testEvent(runtime, { content: '/Pixiv   RANDOM 第一行\n第二行' })
    // @ 机器人免前缀同样认子命令
    await testEvent(runtime, { content: 'pixiv random' })
    expect(calls).toEqual([
      { name: 'pixiv random', command: 'pixiv random', args: ['大图'], argText: '大图' },
      { name: 'pixiv random', command: 'Pixiv RANDOM', args: ['第一行', '第二行'], argText: '第一行\n第二行' },
      { name: 'pixiv random', command: 'pixiv random', args: [], argText: '' },
    ])
  })

  it('对不上子命令时落回父命令，参数照常给', async () => {
    const { pixiv, calls } = makePixiv()
    const runtime = createRuntime({ plugins: [pixiv] })
    await testEvent(runtime, { content: '/pixiv' })
    await testEvent(runtime, { content: '/pixiv 别的 x' })
    // 只有前一半对上（random 后面没空格）不算子命令
    await testEvent(runtime, { content: '/pixiv randomly' })
    expect(calls.map((c) => [c.name, c.args])).toEqual([
      ['pixiv', []],
      ['pixiv', ['别的', 'x']],
      ['pixiv', ['randomly']],
    ])
  })

  it('子命令权限不够时不退回父命令', async () => {
    const { pixiv, calls } = makePixiv()
    const runtime = createRuntime({ plugins: [pixiv] })
    expect((await testEvent(runtime, { content: '/pixiv illust 123' })).matched).toEqual([])
    expect(calls).toEqual([])
  })

  it('跨插件也是最长的命令名胜出', async () => {
    const parent = definePlugin({ name: 'parent', version: '1.0.0', commands: { pixiv: () => 'parent' } })
    const child = definePlugin({ name: 'child', version: '1.0.0', commands: { 'pixiv random': () => 'child' } })
    const runtime = createRuntime({ plugins: [parent, child] })
    expect((await testEvent(runtime, { content: '/pixiv random' })).matched).toEqual([
      { plugin: 'child', kind: 'command', name: 'pixiv random' },
    ])
    expect((await testEvent(runtime, { content: '/pixiv' })).matched).toEqual([{ plugin: 'parent', kind: 'command', name: 'pixiv' }])
  })
})

describe('无前缀解析与头像', () => {
  it('parseBareCommand 取首词，空内容返回 null', () => {
    expect(parseBareCommand('sign 早起')).toEqual({ word: 'sign', args: ['早起'], argText: '早起', text: 'sign 早起', bare: true })
    expect(parseBareCommand('')).toBeNull()
    expect(parseCommand('/echo x', ['/'])).toMatchObject({ word: 'echo', bare: false })
  })

  it('avatarUrl 按官方 CDN 规范拼接（默认 640）', () => {
    const sender = { sendMessage: async () => ({ ok: true, status: 200, raw: null }) }
    const s = buildSession(groupMessagePayload('签到'), { botId: '1903864677', sender, maxPassiveReplies: 5 })
    expect(s.avatarUrl).toBe('https://thirdqq.qlogo.cn/qqapp/1903864677/U1/640')
  })
})

describe('三层权限', () => {
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
    return (await res.json()) as { matched: Array<{ plugin: string }>; outbox: Array<{ message: unknown }> }
  }

  const admin = definePlugin({
    name: 'admin',
    version: '1.0.0',
    commands: { ban: { permission: 'bot_admin', handler: ({ argText }) => `封禁 ${argText}` } },
  })
  const group = definePlugin({
    name: 'group',
    version: '1.0.0',
    commands: { mute: { permission: 'group_admin', handler: ({ argText }) => `已禁言 ${argText}` } },
    regex: [{ pattern: '^静言 (.+)$', permission: 'group_admin', handler: ({ match }) => `已静言 ${match[1]}` }],
  })
  const open = definePlugin({
    name: 'open',
    version: '1.0.0',
    commands: { hello: () => 'hi' },
    regex: [{ pattern: '.*', handler: () => 'caught' }],
  })

  function withSnapshot(fields: Record<string, unknown>) {
    const env = createEnv()
    env.KV.store.set('rt:snapshot', JSON.stringify({ revision: 1, plugins: {}, ...fields }))
    resetSnapshotCache()
    return env
  }

  it('普通成员触发 bot_admin 命令被静默跳过；名单内用户通过', async () => {
    const runtime = createRuntime({ plugins: [admin] })
    expect((await testEvent(runtime, undefined, { content: '/ban 张三' })).outbox).toEqual([])

    const env = withSnapshot({ admins: ['test-user'] })
    expect((await testEvent(runtime, env, { content: '/ban 张三' })).outbox[0]!.message).toBe('封禁 张三')
  })

  it('群管理员与群主通过 group_admin，普通成员不行；正则同样受控', async () => {
    const runtime = createRuntime({ plugins: [group] })
    expect((await testEvent(runtime, undefined, { content: '/mute 李四' })).outbox).toEqual([])
    expect((await testEvent(runtime, undefined, { content: '/mute 李四', raw: { member_role: 'member' } })).outbox).toEqual([])

    const adminRole = await testEvent(runtime, undefined, { content: '/mute 李四', raw: { member_role: 'admin' } })
    expect(adminRole.outbox[0]!.message).toBe('已禁言 李四')
    const owner = await testEvent(runtime, undefined, { content: '静言 李四', raw: { member_role: 'OWNER' } })
    expect(owner.outbox[0]!.message).toBe('已静言 李四')
  })

  it('单聊层级塌缩：group_admin 只有 Bot 管理员能用', async () => {
    const runtime = createRuntime({ plugins: [group] })
    expect((await testEvent(runtime, undefined, { scene: 'c2c', targetId: 'U1', content: '/mute 李四' })).outbox).toEqual([])

    const env = withSnapshot({ admins: ['test-user'] })
    expect(
      (await testEvent(runtime, env, { scene: 'c2c', targetId: 'U1', content: '/mute 李四' })).outbox[0]!.message,
    ).toBe('已禁言 李四')
  })

  it('统一回复仅在没有其他候选命中时触发，不遮蔽其他插件', async () => {
    const env = withSnapshot({ permissionDeniedReply: '权限不足' })

    // 只有高权限命令、无其他候选：回复统一文案
    const solo = createRuntime({ plugins: [admin] })
    expect((await testEvent(solo, env, { content: '/ban 张三' })).outbox[0]!.message).toBe('权限不足')
    // 完全没有候选命中的消息不回复
    expect((await testEvent(solo, env, { content: '/hello' })).outbox).toEqual([])

    // 有普通成员可命中的候选时，不遮蔽、也不补拒绝文案
    const shadowed = createRuntime({ plugins: [admin, open] })
    expect((await testEvent(shadowed, env, { content: '/ban 张三' })).outbox.map((o) => o.message)).toEqual(['caught'])
  })

  it('session.memberRole 来自入站角色并归一化，未知值与单聊为 undefined', () => {
    const sender = { sendMessage: async () => ({ ok: true, status: 200, raw: null }) }
    const opts = { botId: 'b', sender, maxPassiveReplies: 5 }

    const plain = buildSession(groupMessagePayload('hi'), opts)
    expect(plain.memberRole).toBeUndefined()

    const owner = buildSession(
      {
        op: 0,
        id: 'GROUP_AT_MESSAGE_CREATE:x',
        t: 'GROUP_AT_MESSAGE_CREATE',
        d: { id: 'm', content: 'hi', author: { member_openid: 'U1', member_role: 'OWNER' }, group_openid: 'G1' },
      },
      opts,
    )
    expect(owner.memberRole).toBe('owner')

    const c2c = buildSession(
      { op: 0, id: 'C2C:x', t: 'C2C_MESSAGE_CREATE', d: { id: 'm', content: 'hi', author: { member_role: 'admin' } } },
      opts,
    )
    expect(c2c.memberRole).toBeUndefined()
  })
})

describe('第一批打包：mentions / atMe / 机器人资料', () => {
  const sender = { sendMessage: async () => ({ ok: true, status: 200, raw: null }) }
  const opts = { botId: 'b', sender, maxPassiveReplies: 5 }

  it('at_message 事件 atMe 恒为 true；群全量消息按 is_you，频道全量消息按 bot 标记', () => {
    const at = buildSession(groupMessagePayload('hi'), opts)
    expect(at.atMe).toBe(true)
    expect(at.mentions).toEqual([])

    const groupFull = (mentions?: Array<Record<string, unknown>>) =>
      buildSession(
        {
          op: 0,
          id: 'GROUP_MESSAGE_CREATE:x',
          t: 'GROUP_MESSAGE_CREATE',
          d: { id: 'm', content: 'hi', author: { member_openid: 'U1' }, group_openid: 'G1', ...(mentions ? { mentions } : {}) },
        },
        opts,
      )

    const mentioned = groupFull([{ id: 'BOT', username: 'bot', bot: true, is_you: true }])
    expect(mentioned.atMe).toBe(true)
    expect(mentioned.mentions).toEqual([{ id: 'BOT', username: 'bot', bot: true }])
    // @ 的是群里别的机器人：bot 标记为真，但不是本机器人
    expect(groupFull([{ id: 'OTHER', username: 'other', bot: true, is_you: false }]).atMe).toBe(false)
    expect(groupFull().atMe).toBe(false)

    const guildFull = buildSession(
      {
        op: 0,
        id: 'MESSAGE_CREATE:z',
        t: 'MESSAGE_CREATE',
        d: { id: 'm3', content: 'hi', author: { id: 'U2' }, channel_id: 'C1', guild_id: 'GD1', mentions: [{ id: 'BOT', bot: true }] },
      },
      opts,
    )
    expect(guildFull.atMe).toBe(true)
  })

  it('单聊天然 atMe，交互事件恒为 false', () => {
    const c2c = buildSession(
      { op: 0, id: 'C2C:x', t: 'C2C_MESSAGE_CREATE', d: { id: 'm', content: 'hi', author: { user_openid: 'U9' } } },
      opts,
    )
    expect(c2c.atMe).toBe(true)

    const interaction = buildSession(
      { op: 0, id: 'I:x', t: 'INTERACTION_CREATE', d: { id: 'i', type: 11, scene: 'group', group_openid: 'G1', data: { type: 11, resolved: { button_id: 'k' } } } },
      opts,
    )
    expect(interaction.atMe).toBe(false)
  })

  it('botName/botAvatar 来自 SessionOptions，未配置为空串', () => {
    expect(buildSession(groupMessagePayload('hi'), { ...opts, botName: '小助手', botAvatar: 'https://a/640' }).botName).toBe('小助手')
    expect(buildSession(groupMessagePayload('hi'), opts).botAvatar).toBe('')
  })

  it('面板保存凭证时拉取 /users/@me 存进快照', async () => {
    const qq = createQQFetch()
    const runtime = createRuntime({ plugins: [], fetchImpl: qq.fetchImpl })
    const env = createEnv()
    const res = await runtime.fetch!(
      new Request(`${BASE}/admin/bot`, {
        method: 'PUT',
        headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
        body: JSON.stringify({ appId: '123', secret: TEST_SECRET }),
      }),
      env,
      createExecutionContext(),
    )
    expect(await res.json()).toMatchObject({ ok: true, appId: '123' })
    expect(JSON.parse(env.KV.store.get('rt:snapshot')!)).toMatchObject({
      bot: { name: '测试机器人', avatar: 'https://thirdqq.qlogo.cn/bot/640' },
    })
  })

  it('扫码创建：建任务 → 轮询等待 → 完成后解密、验证并保存凭证', async () => {
    const qq = createQQFetch()
    let bindKey = ''
    let polls = 0
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/lite/create_bind_task')) {
        bindKey = JSON.parse(String(init?.body)).key
        return new Response(JSON.stringify({ retcode: 0, data: { task_id: 'task-1' } }))
      }
      if (url.endsWith('/lite/poll_bind_result')) {
        if (++polls === 1) return new Response(JSON.stringify({ retcode: 0, data: { status: 1 } }))
        // 按 q.qq.com 的格式加密：base64(nonce ‖ 密文 ‖ tag)
        const key = await crypto.subtle.importKey('raw', Uint8Array.from(atob(bindKey), (c) => c.charCodeAt(0)), 'AES-GCM', false, ['encrypt'])
        const iv = crypto.getRandomValues(new Uint8Array(12))
        const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(TEST_SECRET)))
        const encrypted = btoa(String.fromCharCode(...iv, ...sealed))
        return new Response(JSON.stringify({ retcode: 0, data: { status: 2, bot_appid: '456', bot_encrypt_secret: encrypted, user_openid: 'U1' } }))
      }
      return qq.fetchImpl(input, init)
    }
    const runtime = createRuntime({ plugins: [], fetchImpl })
    const env = createEnv()
    const call = (path: string, body?: unknown) =>
      runtime.fetch!(
        new Request(`${BASE}/admin${path}`, {
          method: 'POST',
          headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        }),
        env,
        createExecutionContext(),
      )

    const task = (await (await call('/bot/bind')).json()) as { taskId: string; key: string; qrUrl: string }
    expect(task).toMatchObject({ taskId: 'task-1', key: bindKey, qrUrl: expect.stringContaining('connect.html?task_id=task-1') })

    expect(await (await call('/bot/bind/poll', { taskId: task.taskId, key: task.key })).json()).toEqual({ ok: true, status: 'pending' })
    expect(await (await call('/bot/bind/poll', { taskId: task.taskId, key: task.key })).json()).toEqual({ ok: true, status: 'created', appId: '456' })
    expect(JSON.parse(env.KV.store.get('rt:bot')!)).toEqual({ appId: '456', secret: TEST_SECRET })
  })
})

describe('切换机器人', () => {
  /** 按 AppID 回不同名字；bad 里的 AppID 换 token 失败 */
  function botFetch(bad: Set<string> = new Set()) {
    let lastAppId = ''
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      if (url.includes('getAppAccessToken')) {
        lastAppId = JSON.parse(String(init?.body)).appId
        if (bad.has(lastAppId)) return new Response(JSON.stringify({ code: 100016, message: 'invalid appid or secret' }), { status: 400 })
        return new Response(JSON.stringify({ access_token: `tok-${lastAppId}`, expires_in: 7200 }))
      }
      if (url.includes('/users/@me')) {
        const appId = new Headers(init?.headers).get('x-union-appid')
        return new Response(JSON.stringify({ username: `机器人${appId}`, avatar: `https://a/${appId}` }))
      }
      return new Response('{}')
    }
    return fetchImpl
  }

  function setup(bad?: Set<string>, env = createEnv({ BOT_APPID: undefined, BOT_SECRET: undefined })) {
    const runtime = createRuntime({ plugins: [], fetchImpl: botFetch(bad) })
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await runtime.fetch!(
        new Request(`${BASE}/admin${path}`, {
          method,
          headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }),
        env,
        createExecutionContext(),
      )
      return { status: res.status, body: (await res.json()) as Record<string, unknown> }
    }
    return { env, call }
  }

  it('换 AppID 时旧的连同资料存下来，列表不回显 AppSecret；同一个号重存不进列表', async () => {
    const { env, call } = setup()
    await call('PUT', '/bot', { appId: '111', secret: 'secret-111' })
    await call('PUT', '/bot', { appId: '111', secret: 'secret-111b' })
    expect(env.KV.store.has('rt:bot_saved')).toBe(false)

    await call('PUT', '/bot', { appId: '222', secret: 'secret-222' })
    expect(JSON.parse(env.KV.store.get('rt:bot')!)).toEqual({ appId: '222', secret: 'secret-222' })
    expect(JSON.parse(env.KV.store.get('rt:bot_saved')!)).toEqual([
      { appId: '111', secret: 'secret-111b', name: '机器人111', avatar: 'https://a/111', savedAt: expect.any(Number) },
    ])
    const listed = await call('GET', '/bot/saved')
    expect(listed.body).toEqual({ ok: true, bots: [{ appId: '111', name: '机器人111', savedAt: expect.any(Number) }] })
    expect(JSON.stringify(listed.body)).not.toContain('secret-111')
    expect((await call('GET', '/status')).body.bot).toEqual({ appId: '222', source: 'kv', name: '机器人222' })
  })

  it('切回已保存的机器人：当前的换进列表，切回的移出列表，快照资料跟着换', async () => {
    const { env, call } = setup()
    await call('PUT', '/bot', { appId: '111', secret: 'secret-111' })
    await call('PUT', '/bot', { appId: '222', secret: 'secret-222' })

    expect(await call('POST', '/bot/switch', { appId: '111' })).toEqual({ status: 200, body: { ok: true, appId: '111' } })
    expect(JSON.parse(env.KV.store.get('rt:bot')!)).toEqual({ appId: '111', secret: 'secret-111' })
    expect((await call('GET', '/bot/saved')).body.bots).toEqual([{ appId: '222', name: '机器人222', savedAt: expect.any(Number) }])
    expect(JSON.parse(env.KV.store.get('rt:snapshot')!).bot).toEqual({ appId: '111', name: '机器人111', avatar: 'https://a/111' })

    expect((await call('POST', '/bot/switch', { appId: '333' })).status).toBe(404)
    expect((await call('POST', '/bot/switch', {})).status).toBe(400)
  })

  it('切换时鉴权失败（比如平台上重置了 AppSecret）：什么都不改', async () => {
    const bad = new Set<string>()
    const { env, call } = setup(bad)
    await call('PUT', '/bot', { appId: '111', secret: 'secret-111' })
    await call('PUT', '/bot', { appId: '222', secret: 'secret-222' })
    const before = { bot: env.KV.store.get('rt:bot'), saved: env.KV.store.get('rt:bot_saved') }

    bad.add('111')
    const res = await call('POST', '/bot/switch', { appId: '111' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/鉴权失败/)
    expect({ bot: env.KV.store.get('rt:bot'), saved: env.KV.store.get('rt:bot_saved') }).toEqual(before)
  })

  it('删除已保存的机器人；删光后连键一起删', async () => {
    const { env, call } = setup()
    await call('PUT', '/bot', { appId: '111', secret: 'secret-111' })
    await call('PUT', '/bot', { appId: '222', secret: 'secret-222' })

    expect(await call('DELETE', '/bot/saved/111')).toEqual({ status: 200, body: { ok: true, appId: '111' } })
    expect(env.KV.store.has('rt:bot_saved')).toBe(false)
    expect((await call('DELETE', '/bot/saved/111')).status).toBe(404)
    expect(JSON.parse(env.KV.store.get('rt:bot')!).appId).toBe('222')
  })

  it('凭证来自 Worker Secret 时拒绝切换', async () => {
    const env = createEnv()
    env.KV.store.set('rt:bot_saved', JSON.stringify([{ appId: '111', secret: 'secret-111', savedAt: 1 }]))
    const { call } = setup(undefined, env)
    const res = await call('POST', '/bot/switch', { appId: '111' })
    expect(res.status).toBe(409)
    expect(env.KV.store.has('rt:bot')).toBe(false)
  })

  it('老快照的机器人资料没标 appId：按属于当前机器人处理，换号时跟着存下来', async () => {
    const { env, call } = setup()
    env.KV.store.set('rt:bot', JSON.stringify({ appId: '111', secret: 'secret-111' }))
    env.KV.store.set('rt:snapshot', JSON.stringify({ revision: 3, plugins: {}, bot: { name: '老名字', avatar: 'https://old' } }))
    await call('PUT', '/bot', { appId: '222', secret: 'secret-222' })
    expect(JSON.parse(env.KV.store.get('rt:bot_saved')!)[0]).toMatchObject({ appId: '111', name: '老名字', avatar: 'https://old' })
  })

  it('换号时拉不到新号资料：快照里不留上一个的名字', async () => {
    const { env, call } = setup()
    const runtime = createRuntime({
      plugins: [],
      fetchImpl: async (input) =>
        String(input).includes('getAppAccessToken')
          ? new Response(JSON.stringify({ access_token: 't', expires_in: 7200 }))
          : new Response('{}', { status: 500 }),
    })
    env.KV.store.set('rt:bot', JSON.stringify({ appId: '111', secret: 'secret-111' }))
    env.KV.store.set('rt:snapshot', JSON.stringify({ revision: 3, plugins: {}, bot: { name: '老名字', avatar: 'https://old' } }))
    const res = await runtime.fetch!(
      new Request(`${BASE}/admin/bot`, {
        method: 'PUT',
        headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
        body: JSON.stringify({ appId: '222', secret: 'secret-222' }),
      }),
      env,
      createExecutionContext(),
    )
    expect(res.status).toBe(200)
    expect(JSON.parse(env.KV.store.get('rt:snapshot')!).bot).toBeUndefined()
    expect((await call('GET', '/status')).body.bot).toEqual({ appId: '222', source: 'kv', name: '' })
  })
})

describe('QQ 全局配置代理（指令面板 / 分享链接）', () => {
  function adminRequest(method: string, path: string, body?: unknown) {
    return new Request(`${BASE}/admin${path}`, {
      method,
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }

  it('GET/POST/DELETE /admin/qq/panels 校验 scope 并透传到 QQ', async () => {
    const qq = createQQFetch()
    const runtime = createRuntime({ plugins: [], fetchImpl: qq.fetchImpl })
    const env = createEnv()

    const missingScope = await runtime.fetch!(adminRequest('GET', '/qq/panels'), env, createExecutionContext())
    expect(missingScope.status).toBe(400)

    const view = await runtime.fetch!(adminRequest('GET', '/qq/panels?scope=group'), env, createExecutionContext())
    expect(view.status).toBe(200)
    expect(await view.json()).toMatchObject({ ok: true, status: 200, data: { records: [], is_end: true } })

    const created = await runtime.fetch!(
      adminRequest('POST', '/qq/panels', { scope: 'group', target_type: 'all', panel: { items: [] } }),
      env,
      createExecutionContext(),
    )
    expect(created.status).toBe(200)
    expect((await created.json()).data).toMatchObject({ panel_id: 'p1' })

    const removed = await runtime.fetch!(adminRequest('DELETE', '/qq/panels/p1'), env, createExecutionContext())
    expect(removed.status).toBe(200)
    expect((await removed.json()).ok).toBe(true)

    const sent = qq.sent.filter((s) => s.url.includes('/v2/panels')).find((s) => s.body.scope === 'group')
    expect(sent).toBeDefined()
    expect(sent!.body).toMatchObject({ scope: 'group', target_type: 'all', panel: { items: [] } })
  })

  it('POST /admin/qq/url-link 透传并返回链接', async () => {
    const qq = createQQFetch()
    const runtime = createRuntime({ plugins: [], fetchImpl: qq.fetchImpl })
    const env = createEnv()
    const res = await runtime.fetch!(adminRequest('POST', '/qq/url-link', {}), env, createExecutionContext())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, data: { url: 'https://q.qq.com/bot/invite' } })
  })

  it('机器人未配置时返回 503', async () => {
    const runtime = createRuntime({ plugins: [], fetchImpl: (async () => new Response('{}')) as typeof fetch })
    const env = createEnv({ BOT_SECRET: undefined, BOT_APPID: undefined })
    const res = await runtime.fetch!(adminRequest('GET', '/qq/panels'), env, createExecutionContext())
    expect(res.status).toBe(503)
  })
})

describe('自定义菜单端点', () => {
  function adminRequest(method: string, path: string, body?: unknown) {
    return new Request(`${BASE}/admin${path}`, {
      method,
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }

  it('GET 回显当前菜单，PUT 校验 menu 字段并透传', async () => {
    const qq = createQQFetch()
    const runtime = createRuntime({ plugins: [], fetchImpl: qq.fetchImpl })
    const env = createEnv()

    const view = await runtime.fetch!(adminRequest('GET', '/qq/menu'), env, createExecutionContext())
    expect(view.status).toBe(200)
    expect(await view.json()).toMatchObject({ ok: true, data: { version: 1 } })

    const missing = await runtime.fetch!(adminRequest('PUT', '/qq/menu', {}), env, createExecutionContext())
    expect(missing.status).toBe(400)

    const menu = { menu: { items: [{ type: 'send_message', name: '帮助', send_message: '/help' }] } }
    const saved = await runtime.fetch!(adminRequest('PUT', '/qq/menu', menu), env, createExecutionContext())
    expect(saved.status).toBe(200)
    expect((await saved.json()).ok).toBe(true)
    const sent = qq.sent.filter((s) => s.url.includes('/v2/menu')).find((s) => s.body.menu)
    expect(sent!.body).toEqual(menu)
  })
})
