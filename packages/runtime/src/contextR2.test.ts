/**
 * ctx.r2 的键前缀隔离与分页。走真实的 ContextFactory，顺带验证它接线到位。
 */
import { describe, expect, it } from 'vitest'
import { ContextFactory } from './context.js'
import { PluginRegistry } from './registry.js'
import { createEnv, createExecutionContext } from './testing/mocks.js'
import type { RuntimeEnv, Snapshot } from './types.js'

function ctxOf(name: string, env: RuntimeEnv) {
  const registry = new PluginRegistry([])
  const snapshot: Snapshot = { revision: 1, plugins: {} }
  const factory = new ContextFactory({
    env,
    execCtx: createExecutionContext(),
    registry,
    snapshot,
    botId: 'test',
    api: {} as never,
  })
  // ContextFactory.for 只用到 manifest 的这三个字段
  return factory.for({ manifest: { name, version: '1.0.0', defaultConfig: {} } } as never)
}

describe('ctx.r2 的插件隔离', () => {
  it('写入时加前缀，读取时用原始键', async () => {
    const env = createEnv()
    const ctx = ctxOf('hello', env)

    await ctx.r2.put('a/b.png', 'PNGDATA')
    // 真实键带前缀，插件感知不到
    expect([...env.R2.store.keys()]).toEqual(['p/hello/a/b.png'])
    expect(await ctx.r2.getText('a/b.png')).toBe('PNGDATA')
  })

  it('两个插件用同一个键互不干扰', async () => {
    const env = createEnv()
    const a = ctxOf('alpha', env)
    const b = ctxOf('beta', env)

    await a.r2.put('shared', 'A 的')
    await b.r2.put('shared', 'B 的')

    expect(await a.r2.getText('shared')).toBe('A 的')
    expect(await b.r2.getText('shared')).toBe('B 的')
    expect(env.R2.store.size).toBe(2)
  })

  it('list 只看得到自己的对象，且键已去掉前缀', async () => {
    const env = createEnv()
    const a = ctxOf('alpha', env)
    const b = ctxOf('beta', env)

    await a.r2.put('x', '1')
    await a.r2.put('y', '2')
    await b.r2.put('z', '3')

    expect((await a.r2.list()).map((o) => o.key).sort()).toEqual(['x', 'y'])
    expect((await b.r2.list()).map((o) => o.key)).toEqual(['z'])
  })

  it('list 会翻页取全，不是只拿第一页', async () => {
    const env = createEnv()
    const ctx = ctxOf('hello', env)
    // 假 R2 每页最多 2 条，5 条必须翻 3 页
    for (const k of ['a', 'b', 'c', 'd', 'e']) await ctx.r2.put(k, k)

    expect((await ctx.r2.list()).map((o) => o.key).sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('list 的 limit 是总数上限而不是每页上限', async () => {
    const env = createEnv()
    const ctx = ctxOf('hello', env)
    for (const k of ['a', 'b', 'c', 'd', 'e']) await ctx.r2.put(k, k)

    expect(await ctx.r2.list('', { limit: 3 })).toHaveLength(3)
    expect(await ctx.r2.list('', { limit: 10 })).toHaveLength(5)
  })

  it('list 的子前缀在插件前缀之内', async () => {
    const env = createEnv()
    const ctx = ctxOf('hello', env)
    await ctx.r2.put('img/1.png', '1')
    await ctx.r2.put('img/2.png', '2')
    await ctx.r2.put('log/1.txt', '3')

    expect((await ctx.r2.list('img/')).map((o) => o.key).sort()).toEqual(['img/1.png', 'img/2.png'])
  })

  it('head 返回去掉前缀的键与大小；delete 支持批量', async () => {
    const env = createEnv()
    const ctx = ctxOf('hello', env)
    await ctx.r2.put('k', 'abc')

    expect(await ctx.r2.head('k')).toMatchObject({ key: 'k', size: 3 })
    expect(await ctx.r2.head('nope')).toBeNull()

    await ctx.r2.put('k2', 'x')
    await ctx.r2.delete(['k', 'k2'])
    expect(env.R2.store.size).toBe(0)
  })

  it('未绑定 R2 时给出可读错误而不是 undefined 崩溃', async () => {
    const env = createEnv({ R2: undefined })
    const ctx = ctxOf('hello', env)

    await expect(ctx.r2.get('k')).rejects.toThrow(/未绑定 R2/)
    await expect(ctx.r2.put('k', 'v')).rejects.toThrow(/未绑定 R2/)
  })
})
