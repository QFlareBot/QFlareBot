/**
 * 生命周期钩子在并发请求下的约束：所有请求 await 同一次就绪过程。
 * 以前 onBoot 一开始跑就记成「已启动」，并发进来的请求不等它跑完就进了处理器；onInstall 也会被各跑一遍。
 */
import type { Logger, PluginDefinition } from '@qqbot/sdk'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ContextFactory } from './context.js'
import { ensureReady, resetLifecycle } from './lifecycle.js'
import type { RegisteredPlugin } from './registry.js'
import { createKV } from './testing/mocks.js'
import type { RuntimeEnv } from './types.js'

const logger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
const contexts = { prepare: async () => ({}) } as unknown as ContextFactory

function registered(name: string): RegisteredPlugin {
  return { manifest: { name, version: '1.0.0' } } as unknown as RegisteredPlugin
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

/** 让已排队的微任务跑完 */
const tick = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => resetLifecycle())

describe('ensureReady', () => {
  it('onBoot 跑完之前，并发请求都在等，不会提前进处理器', async () => {
    const env = { KV: createKV() } as unknown as RuntimeEnv
    const gate = deferred()
    let boots = 0
    const def = {
      name: 'p',
      hooks: {
        onBoot: async () => {
          boots++
          await gate.promise
        },
      },
    } as unknown as PluginDefinition<unknown>

    const done: number[] = []
    const first = ensureReady(registered('p'), def, env, contexts, logger).then(() => done.push(1))
    const second = ensureReady(registered('p'), def, env, contexts, logger).then(() => done.push(2))
    await tick()
    expect(done).toEqual([])

    gate.resolve()
    await Promise.all([first, second])
    expect(done).toEqual([1, 2])
    expect(boots).toBe(1)
  })

  it('onInstall 并发只跑一次，KV 标记写一次', async () => {
    const kv = createKV()
    const env = { KV: kv } as unknown as RuntimeEnv
    const gate = deferred()
    let installs = 0
    const def = {
      name: 'p',
      hooks: {
        onInstall: async () => {
          installs++
          await gate.promise
        },
      },
    } as unknown as PluginDefinition<unknown>

    const all = Promise.all([1, 2, 3].map(() => ensureReady(registered('p'), def, env, contexts, logger)))
    await tick()
    gate.resolve()
    await all
    expect(installs).toBe(1)
    expect(kv.store.get('rt:installed:p')).toBe('1.0.0')
  })

  it('onInstall 失败本 isolate 不重试，onBoot 照跑；KV 标记跨部署只跑一次', async () => {
    const kv = createKV()
    const env = { KV: kv } as unknown as RuntimeEnv
    const calls: string[] = []
    const def = {
      name: 'p',
      hooks: {
        onInstall: async () => {
          calls.push('install')
          throw new Error('建表失败')
        },
        onBoot: async () => void calls.push('boot'),
      },
    } as unknown as PluginDefinition<unknown>

    await ensureReady(registered('p'), def, env, contexts, logger)
    await ensureReady(registered('p'), def, env, contexts, logger)
    expect(calls).toEqual(['install', 'boot'])
    expect(kv.store.has('rt:installed:p')).toBe(false)

    // 新 isolate（resetLifecycle）：标记已在的插件不再跑 onInstall，onBoot 每个 isolate 一次
    kv.store.set('rt:installed:p', '1.0.0')
    resetLifecycle()
    await ensureReady(registered('p'), def, env, contexts, logger)
    expect(calls).toEqual(['install', 'boot', 'boot'])
  })

  it('读 KV 标记失败：这次就绪失败，下个请求重来', async () => {
    const kv = createKV()
    let broken = true
    const env = {
      KV: { ...kv, get: async (key: string) => (broken ? Promise.reject(new Error('KV 挂了')) : kv.get(key)) },
    } as unknown as RuntimeEnv
    let installs = 0
    const def = { name: 'p', hooks: { onInstall: async () => void installs++ } } as unknown as PluginDefinition<unknown>

    await expect(ensureReady(registered('p'), def, env, contexts, logger)).rejects.toThrow('KV 挂了')
    broken = false
    await ensureReady(registered('p'), def, env, contexts, logger)
    expect(installs).toBe(1)
  })

  it('不同插件互不等待', async () => {
    const env = { KV: createKV() } as unknown as RuntimeEnv
    const gate = deferred()
    const slow = { name: 'slow', hooks: { onBoot: () => gate.promise } } as unknown as PluginDefinition<unknown>
    const fast = { name: 'fast', hooks: { onBoot: async () => {} } } as unknown as PluginDefinition<unknown>

    const pending = ensureReady(registered('slow'), slow, env, contexts, logger)
    await ensureReady(registered('fast'), fast, env, contexts, logger)
    gate.resolve()
    await pending
  })
})
