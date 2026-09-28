/**
 * ctx.publicUrl：设置页填了用填的，没填用请求进来的域名（只认 https），定时任务里只有填了才有
 */
import { definePlugin } from '@qqbot/sdk'
import { beforeEach, describe, expect, it } from 'vitest'
import { resetLifecycle } from './lifecycle.js'
import { isHttpsOrigin, publicUrlFor } from './publicUrl.js'
import { createRuntime } from './runtime.js'
import { resetSnapshotCache } from './store.js'
import { createEnv, createExecutionContext, createQQFetch, groupMessagePayload, signedRequest } from './testing/mocks.js'

beforeEach(() => {
  resetSnapshotCache()
  resetLifecycle()
})

describe('publicUrlFor', () => {
  it('设置里填了用填的，没填用请求的 origin，都只认 https', () => {
    expect(publicUrlFor({ revision: 0, plugins: {}, publicUrl: 'https://img.example.com' }, 'https://bot.example.com')).toBe('https://img.example.com')
    expect(publicUrlFor({ revision: 0, plugins: {} }, 'https://bot.example.com')).toBe('https://bot.example.com')
    expect(publicUrlFor({ revision: 0, plugins: {} }, 'http://localhost:8787')).toBeUndefined()
    expect(publicUrlFor({ revision: 0, plugins: {} })).toBeUndefined()
    // 快照是整份 PUT 进来的，形状不对就当没填
    expect(publicUrlFor({ revision: 0, plugins: {}, publicUrl: 'https://x.com/path' } as never, 'https://bot.example.com')).toBe('https://bot.example.com')
  })

  it('isHttpsOrigin 只收不带路径的 https 地址', () => {
    expect(isHttpsOrigin('https://bot.example.com')).toBe(true)
    expect(isHttpsOrigin('https://bot.example.com:8443')).toBe(true)
    for (const bad of ['https://bot.example.com/', 'https://bot.example.com/p', 'http://bot.example.com', 'bot.example.com', '', 1, null]) {
      expect(isHttpsOrigin(bad)).toBe(false)
    }
  })
})

describe('插件拿到的 ctx.publicUrl', () => {
  const seen: Array<string | undefined> = []
  const plugin = definePlugin({
    name: 'img',
    version: '1.0.0',
    commands: {
      img: {
        async handler({ ctx }) {
          seen.push(ctx.publicUrl)
        },
      },
    },
    cron: [{ name: 'tick', cron: '* * * * *', handler: async ({ ctx }) => void seen.push(ctx.publicUrl) }],
  })

  const event = async (base: string, env = createEnv()) => {
    const runtime = createRuntime({ plugins: [plugin], fetchImpl: createQQFetch().fetchImpl })
    const execCtx = createExecutionContext()
    await runtime.fetch!(await signedRequest(`${base}/webhook`, groupMessagePayload('/img', `e-${Math.random()}`)), env, execCtx)
    await execCtx.flush()
  }
  const tick = async (env = createEnv()) => {
    const runtime = createRuntime({ plugins: [plugin] })
    await runtime.scheduled!({ scheduledTime: Date.now(), cron: '* * * * *', noRetry() {} } as ScheduledController, env, createExecutionContext())
  }
  const withSetting = async () => {
    const env = createEnv()
    await env.KV.put('rt:snapshot', JSON.stringify({ revision: 1, plugins: {}, publicUrl: 'https://img.example.com' }))
    return env
  }

  beforeEach(() => {
    seen.length = 0
  })

  it('事件里没填设置：是 QQ 推送用的那个域名；http 的不给', async () => {
    await event('https://bot.example.com')
    resetSnapshotCache()
    await event('http://localhost:8787')
    expect(seen).toEqual(['https://bot.example.com', undefined])
  })

  it('填了设置：事件和定时任务里都是填的', async () => {
    await event('https://bot.example.com', await withSetting())
    resetSnapshotCache()
    await tick(await withSetting())
    expect(seen).toEqual(['https://img.example.com', 'https://img.example.com'])
  })

  it('定时任务里没填设置：没有', async () => {
    await tick()
    expect(seen).toEqual([undefined])
  })
})

describe('设置页保存 publicUrl', () => {
  it('https origin 能存，别的 400，null 清掉', async () => {
    const runtime = createRuntime({ plugins: [] })
    const env = createEnv()
    const patch = (publicUrl: unknown) =>
      runtime.fetch!(
        new Request('https://bot.test/admin/snapshot', {
          method: 'PATCH',
          headers: { authorization: 'Bearer admin-token' },
          body: JSON.stringify({ publicUrl }),
        }),
        env,
        createExecutionContext(),
      )
    const stored = async () => JSON.parse((await env.KV.get('rt:snapshot')) ?? '{}') as { publicUrl?: string }

    expect((await patch('https://img.example.com')).status).toBe(200)
    expect((await stored()).publicUrl).toBe('https://img.example.com')
    for (const bad of ['http://img.example.com', 'https://img.example.com/', 'img.example.com', 3]) {
      expect((await patch(bad)).status).toBe(400)
    }
    expect((await patch(null)).status).toBe(200)
    expect(await stored()).not.toHaveProperty('publicUrl')
  })
})
