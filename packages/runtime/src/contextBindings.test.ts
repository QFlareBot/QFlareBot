/**
 * ctx.images / ctx.browser：绑定了就把原对象交给插件，没绑定就是 undefined
 */
import { definePlugin } from '@qqbot/sdk'
import { createRecordingApi } from '@qqbot/sdk/testing'
import { describe, expect, it } from 'vitest'
import { ContextFactory } from './context.js'
import { PluginRegistry } from './registry.js'
import { createEnv, createExecutionContext } from './testing/mocks.js'

function contextOf(env: ReturnType<typeof createEnv>) {
  const registry = new PluginRegistry([definePlugin({ name: 'img' })])
  const factory = new ContextFactory({
    env,
    execCtx: createExecutionContext(),
    registry,
    snapshot: { revision: 1, plugins: {} },
    botId: 'test',
    api: createRecordingApi(),
  })
  return factory.for(registry.get('img')!)
}

describe('ctx.images / ctx.browser', () => {
  it('绑定了就是 env 上的原对象', () => {
    const images = {} as ImagesBinding
    const browser = {} as BrowserRun
    const ctx = contextOf(createEnv({ IMAGES: images, BROWSER: browser }))
    expect(ctx.images).toBe(images)
    expect(ctx.browser).toBe(browser)
  })

  it('没绑定时是 undefined', () => {
    const ctx = contextOf(createEnv())
    expect(ctx.images).toBeUndefined()
    expect(ctx.browser).toBeUndefined()
  })
})
