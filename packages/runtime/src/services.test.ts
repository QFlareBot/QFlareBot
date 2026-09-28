import { definePlugin, extractManifest, type Manifest } from '@qqbot/sdk'
import { beforeEach, describe, expect, it } from 'vitest'
import { dependentsOf } from './installChecks.js'
import { resetLifecycle } from './lifecycle.js'
import { PluginRegistry } from './registry.js'
import { createRuntime } from './runtime.js'
import { isOptionalDependency, optionalDepends, providerFor, requiredDepends, serviceOverview } from './services.js'
import { resetSnapshotCache } from './store.js'
import { createEnv, createExecutionContext } from './testing/mocks.js'
import type { Snapshot } from './types.js'

const BASE = 'https://bot.test'
const admin = { authorization: 'Bearer admin-token', 'content-type': 'application/json' }

beforeEach(() => {
  resetSnapshotCache()
  resetLifecycle()
})

/** 提供 greet 服务的插件；label 区分是谁提供的 */
const greeter = (name: string, label = name) =>
  definePlugin({ name, version: '1.0.0', services: { greet: () => (who: string) => `${label}：你好，${who}` } })

function snapshot(partial: Partial<Snapshot> = {}): Snapshot {
  return { revision: 1, plugins: {}, ...partial }
}

async function testEvent(runtime: ReturnType<typeof createRuntime>, env: ReturnType<typeof createEnv>, content: string) {
  const res = await runtime.fetch!(
    new Request(`${BASE}/admin/test-event`, { method: 'POST', headers: admin, body: JSON.stringify({ content }) }),
    env,
    createExecutionContext(),
  )
  expect(res.status).toBe(200)
  return (await res.json()) as { outbox: Array<{ message: unknown }>; errors: Array<{ plugin: string; message: string }> }
}

function envWith(snap?: Partial<Snapshot>) {
  const env = createEnv()
  if (snap) env.KV.store.set('rt:snapshot', JSON.stringify(snapshot(snap)))
  return env
}

describe('可选依赖的写法', () => {
  it("值写 'optional' 即可选，其余（包括版本范围）都是必需", () => {
    expect(isOptionalDependency('optional')).toBe(true)
    expect(isOptionalDependency(' optional ')).toBe(true)
    expect(isOptionalDependency('*')).toBe(false)
    expect(isOptionalDependency('^1.0.0')).toBe(false)
    const m = { depends: { a: '*', b: 'optional', c: '^1' } }
    expect(requiredDepends(m)).toEqual(['a', 'c'])
    expect(optionalDepends(m)).toEqual(['b'])
  })

  it('卸载提示只算必需依赖：可选依赖的提供者没了，插件照常跑', () => {
    const manifests = new Map<string, Manifest>([
      ['greeter', extractManifest(greeter('greeter'), {})],
      ['needy', extractManifest(definePlugin({ name: 'needy', version: '1.0.0', depends: { greet: '*' } }), {})],
      ['curious', extractManifest(definePlugin({ name: 'curious', version: '1.0.0', depends: { greet: 'optional' } }), {})],
    ])
    expect(dependentsOf('greeter', manifests)).toEqual(['needy'])
  })
})

describe('同名服务由谁提供', () => {
  const registry = new PluginRegistry([greeter('a'), greeter('b'), definePlugin({ name: 'c', version: '1.0.0', services: { other: () => 1 } })])

  it('提供者按注册顺序都留着，不再悄悄忽略后注册的', () => {
    expect(registry.providersOf('greet')).toEqual(['a', 'b'])
    expect(registry.providerOf('greet')).toBe('a')
  })

  it('没选：先注册、且启用着的那个；都停用了回到先注册的', () => {
    expect(providerFor(registry, snapshot(), 'greet')).toBe('a')
    expect(providerFor(registry, snapshot({ plugins: { a: { enabled: false } } }), 'greet')).toBe('b')
    expect(providerFor(registry, snapshot({ plugins: { a: { enabled: false }, b: { enabled: false } } }), 'greet')).toBe('a')
    expect(providerFor(registry, snapshot(), 'missing')).toBeUndefined()
  })

  it('选了就用选的，停用了也不换人；选的插件不提供这个服务就当没选', () => {
    expect(providerFor(registry, snapshot({ serviceProviders: { greet: 'b' } }), 'greet')).toBe('b')
    expect(providerFor(registry, snapshot({ serviceProviders: { greet: 'b' }, plugins: { b: { enabled: false } } }), 'greet')).toBe('b')
    expect(providerFor(registry, snapshot({ serviceProviders: { greet: 'c' } }), 'greet')).toBe('a')
  })

  it('面板的服务列表', () => {
    expect(serviceOverview(registry, snapshot({ serviceProviders: { greet: 'b' } }))).toEqual([
      { name: 'greet', providers: ['a', 'b'], selected: 'b', active: 'b' },
      { name: 'other', providers: ['c'], selected: null, active: 'c' },
    ])
  })
})

describe('ctx.service（经 /admin/test-event 干跑）', () => {
  const consumer = definePlugin({
    name: 'consumer',
    version: '1.0.0',
    depends: { greet: '*' },
    commands: { hi: ({ ctx, argText }) => ctx.service<(who: string) => string>('greet')(argText) },
  })

  it('没在 depends 里声明的拿不到，哪怕同一个请求里别的插件已经解析过', async () => {
    // 两个正则都命中同一条消息：consumer 先跑、先把 greet 解析进这个请求的服务表，sneaky 后跑
    const first = definePlugin({
      name: 'first',
      version: '1.0.0',
      depends: { greet: '*' },
      regex: [{ pattern: '^hi', priority: 10, handler: ({ ctx }) => ctx.service<(w: string) => string>('greet')('first') }],
    })
    const sneaky = definePlugin({
      name: 'sneaky',
      version: '1.0.0',
      regex: [{ pattern: '^hi', handler: ({ ctx }) => ctx.service<(w: string) => string>('greet')('sneaky') }],
    })
    const runtime = createRuntime({ plugins: [greeter('greeter'), first, sneaky] })
    const r = await testEvent(runtime, envWith(), 'hi')
    expect(r.outbox.map((o) => o.message)).toEqual(['greeter：你好，first'])
    expect(r.errors).toEqual([expect.objectContaining({ plugin: 'sneaky', message: expect.stringContaining('没有在 depends 中声明服务 greet') })])
  })

  it('面板选了第二个提供者就用它', async () => {
    const runtime = createRuntime({ plugins: [greeter('a', 'A'), greeter('b', 'B'), consumer] })
    expect((await testEvent(runtime, envWith(), '/hi 小明')).outbox[0]?.message).toBe('A：你好，小明')
    resetSnapshotCache()
    expect((await testEvent(runtime, envWith({ serviceProviders: { greet: 'b' } }), '/hi 小明')).outbox[0]?.message).toBe('B：你好，小明')
  })

  it('链式依赖：提供者自己依赖的服务也解析好，工厂里立即取都拿得到（不再靠提供者带不带钩子）', async () => {
    const decorator = definePlugin({
      name: 'decorator',
      version: '1.0.0',
      depends: { greet: '*' },
      services: {
        fancy: (ctx) => {
          const greet = ctx.service<(who: string) => string>('greet')
          return (who: string) => `✨${greet(who)}✨`
        },
      },
    })
    const user = definePlugin({
      name: 'user',
      version: '1.0.0',
      depends: { fancy: '*' },
      commands: { hi: ({ ctx, argText }) => ctx.service<(who: string) => string>('fancy')(argText) },
    })
    const runtime = createRuntime({ plugins: [greeter('greeter'), decorator, user] })
    const r = await testEvent(runtime, envWith(), '/hi 小明')
    expect(r.errors).toEqual([])
    expect(r.outbox[0]?.message).toBe('✨greeter：你好，小明✨')
  })

  it('依赖成环不会卡住：用到时再取的都拿得到', async () => {
    const ping = definePlugin({
      name: 'ping',
      version: '1.0.0',
      depends: { pong: '*' },
      services: { ping: (ctx) => ({ call: () => `ping→${ctx.service<{ name: string }>('pong').name}` }) },
    })
    const pong = definePlugin({
      name: 'pong',
      version: '1.0.0',
      depends: { ping: '*' },
      services: { pong: () => ({ name: 'pong' }) },
    })
    const user = definePlugin({
      name: 'user',
      version: '1.0.0',
      depends: { ping: '*' },
      commands: { hi: ({ ctx }) => ctx.service<{ call(): string }>('ping').call() },
    })
    const runtime = createRuntime({ plugins: [ping, pong, user] })
    const r = await testEvent(runtime, envWith(), '/hi')
    expect(r.outbox[0]?.message).toBe('ping→pong')
  })

  it('没选时先注册的停用了，自动用下一个启用着的', async () => {
    const runtime = createRuntime({ plugins: [greeter('a', 'A'), greeter('b', 'B'), consumer] })
    const r = await testEvent(runtime, envWith({ plugins: { a: { enabled: false } } }), '/hi 小明')
    expect(r.outbox[0]?.message).toBe('B：你好，小明')
  })

  describe('可选依赖', () => {
    const curious = definePlugin({
      name: 'curious',
      version: '1.0.0',
      depends: { greet: 'optional' },
      commands: {
        hi({ ctx, argText }) {
          try {
            return ctx.service<(who: string) => string>('greet')(argText)
          } catch (err) {
            return `（没有问候服务：${(err as Error).message}）`
          }
        },
      },
    })

    it('有提供者就用', async () => {
      const runtime = createRuntime({ plugins: [greeter('greeter'), curious] })
      const r = await testEvent(runtime, envWith(), '/hi 小明')
      expect(r.outbox[0]?.message).toBe('greeter：你好，小明')
    })

    it('没有提供者：照常跑，ctx.service() 抛错由插件自己兜住', async () => {
      const runtime = createRuntime({ plugins: [curious] })
      const r = await testEvent(runtime, envWith(), '/hi 小明')
      expect(r.errors).toEqual([])
      expect(r.outbox[0]?.message).toBe('（没有问候服务：服务 greet 没有提供者（插件 curious））')
    })

    it('提供者停用：不像必需依赖那样整个处理器报错，调用时才说明原因', async () => {
      const runtime = createRuntime({ plugins: [greeter('greeter'), curious] })
      const r = await testEvent(runtime, envWith({ plugins: { greeter: { enabled: false } } }), '/hi 小明')
      expect(r.errors).toEqual([])
      expect(r.outbox[0]?.message).toContain('未启用')
    })
  })
})

describe('PUT /admin/services/:name', () => {
  const call = (runtime: ReturnType<typeof createRuntime>, env: ReturnType<typeof createEnv>, path: string, init: RequestInit = {}) =>
    runtime.fetch!(new Request(`${BASE}${path}`, { headers: admin, ...init }), env, createExecutionContext())

  it('选一个提供者、再改回默认；status 里看得到', async () => {
    const runtime = createRuntime({ plugins: [greeter('a'), greeter('b')] })
    const env = envWith()

    const set = await call(runtime, env, '/admin/services/greet', { method: 'PUT', body: JSON.stringify({ provider: 'b' }) })
    expect(set.status).toBe(200)
    expect(await set.json()).toMatchObject({ services: [{ name: 'greet', selected: 'b', active: 'b' }] })
    expect(JSON.parse(env.KV.store.get('rt:snapshot')!)).toMatchObject({ serviceProviders: { greet: 'b' } })

    const status = (await (await call(runtime, env, '/admin/status')).json()) as { services: unknown }
    expect(status.services).toEqual([{ name: 'greet', providers: ['a', 'b'], selected: 'b', active: 'b' }])

    const reset = await call(runtime, env, '/admin/services/greet', { method: 'PUT', body: JSON.stringify({ provider: null }) })
    expect(reset.status).toBe(200)
    expect(JSON.parse(env.KV.store.get('rt:snapshot')!).serviceProviders).toBeUndefined()
  })

  it('选的不是提供者 400，没人提供的服务 404', async () => {
    const runtime = createRuntime({ plugins: [greeter('a'), definePlugin({ name: 'x', version: '1.0.0' })] })
    const env = envWith()
    expect((await call(runtime, env, '/admin/services/greet', { method: 'PUT', body: JSON.stringify({ provider: 'x' }) })).status).toBe(400)
    expect((await call(runtime, env, '/admin/services/greet', { method: 'PUT', body: JSON.stringify({}) })).status).toBe(400)
    expect((await call(runtime, env, '/admin/services/nope', { method: 'PUT', body: JSON.stringify({ provider: 'a' }) })).status).toBe(404)
  })
})
