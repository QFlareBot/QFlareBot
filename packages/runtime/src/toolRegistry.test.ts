import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  definePlugin,
  extractManifest,
  type PluginDefinition,
  type PluginHandlerTool,
  type PluginToolRegistry,
  type ToolInvocation,
} from '@qqbot/sdk'
import { createMockSession } from '@qqbot/sdk/testing'
import { ContextFactory } from './context.js'
import { PluginRegistry } from './registry.js'
import { resetLifecycle } from './lifecycle.js'
import { resetSnapshotCache } from './store.js'
import { unavailableApi } from './unavailableApi.js'
import { createEnv, createExecutionContext } from './testing/mocks.js'
import { createRuntime } from './runtime.js'
import type { Snapshot } from './types.js'

beforeEach(() => {
  resetLifecycle()
  resetSnapshotCache()
})
afterEach(() => vi.restoreAllMocks())
const schema = {
  type: 'object',
  required: ['city'],
  additionalProperties: false,
  properties: { city: { type: 'string' } },
}
const tool = (overrides: Partial<PluginHandlerTool> = {}): PluginHandlerTool => ({
  description: '查询城市',
  permission: 'member',
  sideEffect: 'none',
  inputSchema: schema,
  handler: async ({ input, ctx, caller, actor }) => ({
    status: 'success',
    output: { input, provider: ctx.plugin.name, caller: caller.plugin, user: actor.userId },
  }),
  ...overrides,
})
const consumer = (name: string) =>
  definePlugin({ name, version: '1.0.0', depends: { 'core.tools': '*' } })
const weather = (name: string, overrides: Partial<PluginHandlerTool> = {}) =>
  definePlugin({ name, version: '1.0.0', tools: { query: tool(overrides) } })

function setup(
  plugins: PluginDefinition<unknown>[] = [
    consumer('a'),
    consumer('b'),
    weather('weather'),
    weather('other'),
  ],
  snapshot: Snapshot = { revision: 1, plugins: {} },
) {
  const env = createEnv()
  const registry = new PluginRegistry(plugins)
  const fresh = (snap = snapshot) =>
    new ContextFactory({
      env,
      registry,
      snapshot: snap,
      api: unavailableApi(),
      botId: env.BOT_APPID!,
      execCtx: createExecutionContext(),
    })
  const factory = fresh()
  factory.bindSession(
    createMockSession({
      userId: 'user',
      targetId: 'group',
      scene: 'group',
      memberRole: 'member',
      isBotAdmin: false,
    }),
  )
  const service = (name = 'a', f = factory) =>
    f.for(registry.get(name)!).service<PluginToolRegistry>('core.tools')
  return { env, registry, factory, fresh, service, snapshot }
}

async function call(
  service: PluginToolRegistry,
  invocation: ToolInvocation,
  id = 'weather.query',
  extra = {},
) {
  const descriptor = await service.describe(id)
  return service.invoke(
    id,
    { city: '上海' },
    { invocation, callId: 'r1:c1', expectedRevision: descriptor!.revision, ...extra },
  )
}

describe('框架工具目录与执行', () => {
  it('两个消费者同时发现两个同名工具，提供者和调用者身份不混用', async () => {
    const { service } = setup()
    await Promise.all(
      ['a', 'b'].map(async name => {
        const api = service(name)
        const invocation = await api.capture()
        expect((await api.list(invocation)).map(t => t.id)).toEqual([
          'other.query',
          'weather.query',
        ])
        expect(await call(api, invocation)).toMatchObject({
          status: 'success',
          output: { provider: 'weather', caller: name, user: 'user' },
        })
        expect(await call(api, invocation, 'other.query')).toMatchObject({
          output: { provider: 'other' },
        })
      }),
    )
  })

  it('列目录不加载代码；首次调用准备提供者的依赖和生命周期', async () => {
    const events: string[] = []
    const base = definePlugin({
      name: 'base',
      version: '1.0.0',
      hooks: {
        onBoot() {
          events.push('base boot')
        },
      },
      services: {
        base: () => {
          events.push('base service')
          return 'ready'
        },
      },
    })
    const provider = definePlugin({
      ...weather('weather'),
      depends: { base: '*' },
      hooks: {
        onInstall(ctx) {
          expect(ctx.service('base')).toBe('ready')
          events.push('install')
        },
      },
    })
    const { env } = setup()
    const load = vi.fn(async () => ({ default: provider }))
    const registry = new PluginRegistry([
      consumer('a'),
      base,
      { manifest: extractManifest(provider), load },
    ])
    const factory = new ContextFactory({
      env,
      registry,
      snapshot: { revision: 1, plugins: {} },
      api: unavailableApi(),
      botId: env.BOT_APPID!,
      execCtx: createExecutionContext(),
    })
    factory.bindSession(createMockSession({ userId: 'user', targetId: 'g' }))
    const api = (await factory.prepare(registry.get('a')!)).service<PluginToolRegistry>(
      'core.tools',
    )
    await api.list()
    expect(load).not.toHaveBeenCalled()
    expect(await call(api, await api.capture())).toMatchObject({ status: 'success' })
    expect(events).toEqual(['base boot', 'base service', 'install'])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('初始化失败不执行工具', async () => {
    const handler = vi.fn(tool().handler)
    const { service } = setup([
      consumer('a'),
      {
        ...weather('weather', { handler }),
        hooks: {
          onBoot() {
            throw new Error('数据库未就绪')
          },
        },
      },
    ])
    expect(await call(service(), await service().capture())).toMatchObject({
      status: 'failed',
      error: { code: 'tool_failed' },
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('参数错误、版本变更和未知工具都不会进入 handler', async () => {
    const handler = vi.fn(tool().handler)
    const { service } = setup([consumer('a'), weather('weather', { handler })])
    const api = service()
    const invocation = await api.capture()
    const descriptor = (await api.list())[0]!
    expect(
      await api.invoke(
        descriptor.id,
        { city: 5 },
        { invocation, callId: 'c', expectedRevision: descriptor.revision },
      ),
    ).toMatchObject({ error: { code: 'invalid_input' } })
    expect(await call(api, invocation, descriptor.id, { expectedRevision: 'old' })).toMatchObject({
      error: { code: 'tool_changed' },
    })
    expect(
      await api.invoke('missing', {}, { invocation, callId: 'c', expectedRevision: '' }),
    ).toMatchObject({ error: { code: 'unknown_tool' } })
    expect(handler).not.toHaveBeenCalled()
  })

  it('返回值保留错误与媒体结构，不能把失败包装成成功', async () => {
    const { service } = setup([
      consumer('a'),
      weather('weather', {
        handler: async () => ({
          status: 'failed',
          error: { code: 'upstream', message: '不可用', retryable: false },
        }),
      }),
      weather('image', {
        handler: async () => ({
          status: 'success',
          output: '图片',
          artifacts: [{ type: 'image', url: 'https://example.com/a.png' }],
        }),
      }),
    ])
    const api = service()
    const invocation = await api.capture()
    expect(await call(api, invocation)).toMatchObject({
      status: 'failed',
      error: { code: 'upstream' },
    })
    expect(await call(api, invocation, 'image.query')).toMatchObject({
      artifacts: [{ type: 'image' }],
    })
  })
})

describe('调用权限与恢复凭据', () => {
  it('上下文跨请求恢复，不能换调用者、改身份、无凭据或过期后执行', async () => {
    const { service, fresh } = setup()
    const invocation = await service().capture()
    const restarted = fresh()
    expect(await call(service('a', restarted), invocation)).toMatchObject({ status: 'success' })
    expect(await call(service('b', restarted), invocation)).toMatchObject({
      status: 'permission_denied',
    })
    const [payload, signature] = invocation.token.split('.')
    const body = JSON.parse(atob(payload!))
    body.actor.memberRole = 'owner'
    expect(
      await call(service(), { token: `${btoa(JSON.stringify(body))}.${signature}` }),
    ).toMatchObject({ status: 'permission_denied' })
    expect(await call(service(), { token: '' })).toMatchObject({ status: 'permission_denied' })
    await expect(service('a', fresh()).capture()).rejects.toThrow('当前没有用户事件')
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 86400_001)
    expect(await call(service('a', fresh()), invocation)).toMatchObject({
      status: 'permission_denied',
    })
  })

  it('群角色、群范围和消费者白名单在执行时复核，目录快照不能绕过', async () => {
    const snapshot: Snapshot = { revision: 1, plugins: {} }
    const { service, fresh } = setup(
      [consumer('a'), weather('weather'), weather('admin', { permission: 'group_admin' })],
      snapshot,
    )
    const api = service()
    const invocation = await api.capture()
    expect((await api.list(invocation)).map(t => t.id)).toEqual(['weather.query'])
    expect(await call(api, invocation, 'admin.query')).toMatchObject({
      status: 'permission_denied',
    })
    const next: Snapshot = {
      revision: 2,
      plugins: { weather: { enabled: true, groups: { mode: 'deny', ids: ['group'] } } },
    }
    expect(await call(service('a', fresh(next)), invocation)).toMatchObject({
      status: 'permission_denied',
    })
    next.plugins = {}
    next.toolPolicy = { consumers: { a: { allow: [] } } }
    const restricted = service('a', fresh(next))
    expect((await restricted.list()).map(tool => tool.id)).toContain('weather.query')
    expect(await restricted.list(invocation)).toEqual([])
    expect(
      await restricted.invoke(
        'weather.query',
        { city: '上海' },
        {
          invocation,
          callId: 'c',
          expectedRevision: (await api.describe('weather.query'))!.revision,
        },
      ),
    ).toMatchObject({ status: 'permission_denied' })
  })

  it('同一请求的重复调用合并，恢复后的幂等键保持一致', async () => {
    const keys: string[] = []
    const handler = vi.fn(async ({ idempotencyKey }) => {
      keys.push(idempotencyKey)
      return { status: 'success' as const }
    })
    const { service, fresh } = setup([consumer('a'), weather('weather', { handler })])
    const api = service()
    const invocation = await api.capture()
    await Promise.all([call(api, invocation), call(api, invocation)])
    expect(handler).toHaveBeenCalledTimes(1)
    await call(service('a', fresh()), invocation)
    expect(keys[1]).toBe(keys[0])
  })

  it.each(['none', 'external_write'] as const)(
    '超时给 handler 取消信号，%s 的结果按副作用区分',
    async sideEffect => {
      let signal: AbortSignal | undefined
      const { service } = setup([
        consumer('a'),
        weather('weather', {
          sideEffect,
          timeoutMs: 15,
          handler: async input => {
            signal = input.signal
            return new Promise(() => {})
          },
        }),
      ])
      const result = await call(service(), await service().capture())
      expect(result.status).toBe(sideEffect === 'none' ? 'timeout' : 'unknown')
      expect(signal?.aborted).toBe(true)
      if (sideEffect !== 'none') expect(result.error?.retryable).toBe(false)
    },
  )
})

it('经真实事件入口调用 core.tools，框架负责绑定用户身份', async () => {
  const agent = definePlugin({
    ...consumer('chatbot'),
    commands: {
      query: {
        async handler({ ctx }) {
          const tools = ctx.service<PluginToolRegistry>('core.tools')
          const result = await call(tools, await tools.capture())
          return JSON.stringify(result)
        },
      },
    },
  })
  const runtime = createRuntime({ plugins: [agent, weather('weather')] })
  const response = await runtime.fetch!(
    new Request('https://bot.test/admin/test-event', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ content: '/query' }),
    }),
    createEnv(),
    createExecutionContext(),
  )
  const data = (await response.json()) as { errors: unknown[]; outbox: Array<{ message: string }> }
  expect(data.errors).toEqual([])
  expect(JSON.parse(data.outbox[0]!.message)).toMatchObject({
    status: 'success',
    output: { caller: 'chatbot', provider: 'weather' },
  })
})

it('同一请求列出后停用、撤销 Bot 管理权限，执行入口重新读取策略', async () => {
  const snapshot: Snapshot = { revision: 1, plugins: {}, admins: ['user'] }
  const handler = vi.fn(tool().handler)
  const { env, registry } = setup(
    [consumer('a'), weather('weather', { permission: 'bot_admin', handler })],
    snapshot,
  )
  const factory = new ContextFactory({
    env,
    registry,
    snapshot,
    refreshSnapshot: async () => snapshot,
    api: unavailableApi(),
    botId: env.BOT_APPID!,
    execCtx: createExecutionContext(),
  })
  factory.bindSession(createMockSession({ userId: 'user', targetId: 'g', isBotAdmin: true }))
  const api = factory.for(registry.get('a')!).service<PluginToolRegistry>('core.tools')
  const invocation = await api.capture()
  const descriptor = (await api.list(invocation))[0]!
  snapshot.admins = []
  expect(
    await api.invoke(
      descriptor.id,
      { city: '上海' },
      { invocation, callId: 'first', expectedRevision: descriptor.revision },
    ),
  ).toMatchObject({ status: 'permission_denied' })
  snapshot.admins = ['user']
  snapshot.toolPolicy = { disabled: [descriptor.id] }
  expect(
    await api.invoke(
      descriptor.id,
      { city: '上海' },
      { invocation, callId: 'second', expectedRevision: descriptor.revision },
    ),
  ).toMatchObject({ status: 'permission_denied' })
  expect(handler).not.toHaveBeenCalled()
})

it('输入冲突、坏输出和调用前取消均有明确结果', async () => {
  const handler = vi.fn(async () => ({ status: 'success' as const, output: 7 }))
  const { service } = setup([
    consumer('a'),
    weather('weather', { handler, outputSchema: { type: 'string' } }),
  ])
  const api = service()
  const invocation = await api.capture()
  const descriptor = (await api.list())[0]!
  const options = { invocation, callId: 'same', expectedRevision: descriptor.revision }
  expect(await api.invoke(descriptor.id, { city: '上海' }, options)).toMatchObject({
    error: { code: 'invalid_result' },
  })
  expect(await api.invoke(descriptor.id, { city: '北京' }, options)).toMatchObject({
    error: { code: 'call_id_conflict' },
  })
  expect(
    await api.invoke(
      descriptor.id,
      { city: '上海' },
      { ...options, callId: 'cancelled', signal: AbortSignal.abort() },
    ),
  ).toMatchObject({ status: 'cancelled' })
  expect(handler).toHaveBeenCalledTimes(1)
})

it('无必需依赖或清单对应的 handler 时，不误报成功', async () => {
  const broken = { ...weather('weather'), depends: { absent: '*' } }
  const { service } = setup([consumer('a'), broken])
  expect(await call(service(), await service().capture())).toMatchObject({ status: 'failed' })
  resetLifecycle()
  const { env } = setup()
  const registry = new PluginRegistry([
    consumer('a'),
    {
      manifest: extractManifest(weather('weather')),
      load: async () => ({ default: { name: 'weather' } }),
    },
  ])
  const factory = new ContextFactory({
    env,
    registry,
    snapshot: { revision: 1, plugins: {} },
    api: unavailableApi(),
    botId: env.BOT_APPID!,
    execCtx: createExecutionContext(),
  })
  factory.bindSession(createMockSession())
  const api = factory.for(registry.get('a')!).service<PluginToolRegistry>('core.tools')
  expect(await call(api, await api.capture())).toMatchObject({
    error: { code: 'tool_unavailable' },
  })
})

it('提供者不能在 handler 内重新签发身份并递归调用', async () => {
  const handler = vi.fn(async ({ ctx }) => {
    const api = ctx.service<PluginToolRegistry>('core.tools')
    await expect(api.capture()).rejects.toThrow('不能再次签发')
    expect(
      await api.invoke(
        'weather.query',
        {},
        { invocation: { token: '' }, callId: 'nested', expectedRevision: '' },
      ),
    ).toMatchObject({ error: { code: 'nested_tool_call' } })
    return { status: 'success' as const }
  })
  const { service } = setup([
    consumer('a'),
    { ...weather('weather', { handler }), depends: { 'core.tools': '*' } },
  ])
  expect(await call(service(), await service().capture())).toMatchObject({ status: 'success' })
  expect(handler).toHaveBeenCalledTimes(1)
})

it('管理目录和策略接口需要鉴权，保存后新调用立刻受限', async () => {
  const env = createEnv()
  const runtime = createRuntime({ plugins: [consumer('a'), weather('weather')] })
  const fetch = (path: string, init: RequestInit = {}) =>
    runtime.fetch!(
      new Request(`https://bot.test/admin${path}`, init),
      env,
      createExecutionContext(),
    )
  expect((await fetch('/tools')).status).toBe(401)
  const headers = { authorization: 'Bearer admin-token', 'content-type': 'application/json' }
  expect((await fetch('/tools', { headers })).status).toBe(200)
  expect(
    (
      await fetch('/tools/policy', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ consumers: { a: { allow: 'all' } } }),
      })
    ).status,
  ).toBe(400)
  expect(
    (
      await fetch('/tools/policy', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ disabled: ['weather.query'], consumers: { a: { allow: [] } } }),
      })
    ).status,
  ).toBe(200)
  const body = (await (await fetch('/tools', { headers })).json()) as {
    tools: Array<{ available: boolean }>
    policy: unknown
  }
  expect(body.tools[0]?.available).toBe(false)
  expect(body.policy).toMatchObject({ consumers: { a: { allow: [] } } })
})

it('同版本插件换部署来源时，旧 revision 也不能继续执行', async () => {
  const { service, env } = setup()
  const invocation = await service().capture()
  const old = await service().describe('weather.query')
  const registry = new PluginRegistry([
    consumer('a'),
    {
      manifest: extractManifest(weather('weather')),
      origin: { from: 'd1', source: 'git:me/weather@new-commit' },
      load: async () => ({ default: weather('weather') }),
    },
  ])
  const factory = new ContextFactory({
    env,
    registry,
    snapshot: { revision: 1, plugins: {} },
    api: unavailableApi(),
    botId: env.BOT_APPID!,
    execCtx: createExecutionContext(),
  })
  const api = factory.for(registry.get('a')!).service<PluginToolRegistry>('core.tools')
  expect(
    await call(api, invocation, 'weather.query', { expectedRevision: old!.revision }),
  ).toMatchObject({ error: { code: 'tool_changed' } })
})

it.each(['timeout', 'cancelled', 'unknown'] as const)(
  '写 handler 返回 %s 仍保持不可自动重试的未知结果',
  async status => {
    const { service } = setup([
      consumer('a'),
      weather('weather', {
        sideEffect: 'external_write',
        handler: async () => ({
          status,
          error: { code: 'interrupted', message: '结果未知', retryable: true },
        }),
      }),
    ])
    expect(await call(service(), await service().capture())).toMatchObject({
      status: 'unknown',
      error: { retryable: false },
    })
  },
)

// 通过真实服务解析验证绑定，避免只用 vi.fn 模拟 ctx.service 而漏掉实例/提供者串用。
describe('服务方法适配', () => {
  function provider(name: string, creates: string[]) {
    class Weather {
      calls = 0
      query(city: string) {
        this.calls += 1
        return { provider: name, city, calls: this.calls }
      }
      hidden() {
        throw new Error('未公开的方法')
      }
    }
    return definePlugin({
      name,
      version: '1.0.0',
      services: {
        weather: () => {
          creates.push(name)
          return new Weather()
        },
      },
      tools: {
        query: {
          description: '查询城市天气，返回提供者与城市。',
          permission: 'member',
          sideEffect: 'none',
          inputSchema: schema,
          service: 'weather',
          method: 'query',
          mapInput: ({ input }) => [(input as { city: string }).city],
          mapOutput: output => ({ status: 'success', output }),
        },
      },
    })
  }

  it('保留 this，与普通服务共享一次实例；同名服务仍绑定各自提供者', async () => {
    const creates: string[] = []
    const { registry, factory, fresh, service } = setup(
      [
        { ...consumer('a'), depends: { 'core.tools': '*', weather: '*' } },
        provider('weather', creates),
        provider('other', creates),
      ],
      { revision: 1, plugins: {}, serviceProviders: { weather: 'weather' } },
    )
    const ctx = await factory.prepare(registry.get('a')!)
    const ordinary = ctx.service<{ calls: number }>('weather')
    const api = service()
    const invocation = await api.capture()

    const results = await Promise.all([
      call(api, invocation, 'weather.query'),
      call(api, invocation, 'other.query'),
    ])
    expect(results[0]).toMatchObject({
      status: 'success',
      output: { provider: 'weather', city: '上海', calls: 1 },
    })
    expect(results[1]).toMatchObject({ status: 'success', output: { provider: 'other', calls: 1 } })
    expect(ordinary.calls).toBe(1)
    const next = service('a', fresh())
    expect(await call(next, invocation, 'weather.query')).toMatchObject({ output: { calls: 1 } })
    expect(creates.sort()).toEqual(['other', 'weather', 'weather'])
    expect((await api.list()).map(tool => tool.name)).toEqual(['query', 'query'])
    expect(await call(api, invocation, 'weather.query', { callId: 'again' })).toMatchObject({
      output: { calls: 2 },
    })
  })

  it('结果转换保留业务失败，缺失方法不会误报成功', async () => {
    const def = provider('weather', [])
    def.tools!.query.mapOutput = () => ({
      status: 'failed',
      error: { code: 'no_data', message: '没有天气记录', retryable: false },
    })
    const { service } = setup([consumer('a'), def])
    expect(await call(service(), await service().capture())).toMatchObject({
      status: 'failed',
      error: { code: 'no_data' },
    })
    def.tools!.query.method = 'missing'
    const next = setup([consumer('a'), def])
    expect(await call(next.service(), await next.service().capture())).toMatchObject({
      status: 'failed',
      error: { code: 'tool_unavailable' },
    })
  })

  it('参数转换耗尽预算后不再调用方法；写入后的转换失败保持 unknown', async () => {
    const execute = vi.fn(() => 'sent')
    const def = provider('weather', [])
    def.services = { weather: () => ({ query: execute }) }
    def.tools!.query.timeoutMs = 10
    def.tools!.query.mapInput = async () => {
      await new Promise(resolve => setTimeout(resolve, 25))
      return ['上海']
    }
    const first = setup([consumer('a'), def])
    expect(await call(first.service(), await first.service().capture())).toMatchObject({
      status: 'timeout',
    })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(execute).not.toHaveBeenCalled()

    def.tools!.query.timeoutMs = 1000
    def.tools!.query.mapInput = () => ['上海']
    def.tools!.query.sideEffect = 'external_write'
    def.tools!.query.mapOutput = () => {
      throw new Error('返回格式不兼容')
    }
    const second = setup([consumer('a'), def])
    expect(await call(second.service(), await second.service().capture())).toMatchObject({
      status: 'unknown',
      error: { retryable: false },
    })
    expect(execute).toHaveBeenCalledTimes(1)
  })
})
