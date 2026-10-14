import { definePlugin } from '@qqbot/sdk'
import { createRecordingApi } from '@qqbot/sdk/testing'
import { describe, expect, it } from 'vitest'
import { ContextFactory } from './context.js'
import { PluginRegistry } from './registry.js'
import { createEnv, createExecutionContext } from './testing/mocks.js'

describe('ContextFactory 原生绑定', () => {
  it.each([[false, false], [true, false], [false, true], [true, true]])('保持原对象，共享宿主绑定：images=%s browser=%s', (withImages, withBrowser) => {
    // 不提供方法：Context 构造不应探测或调用原生对象的方法。
    const images = {} as ImagesBinding
    const browser = {} as BrowserRun
    const env = createEnv({
      ...(withImages ? { IMAGES: images } : {}),
      ...(withBrowser ? { BROWSER: browser } : {}),
    })
    const registry = new PluginRegistry([definePlugin({ name: 'alpha' }), definePlugin({ name: 'beta' })])
    const factory = new ContextFactory({
      env,
      execCtx: createExecutionContext(),
      registry,
      snapshot: { revision: 1, plugins: {} },
      botId: 'test',
      api: createRecordingApi(),
    })
    for (const name of ['alpha', 'beta']) {
      const plugin = registry.get(name)!
      const ctx = factory.for(plugin)
      expect(Object.hasOwn(ctx, 'images')).toBe(withImages)
      expect(Object.hasOwn(ctx, 'browser')).toBe(withBrowser)
      expect(ctx.images).toBe(withImages ? images : undefined)
      expect(ctx.browser).toBe(withBrowser ? browser : undefined)
      expect(factory.for(plugin)).toBe(ctx)
    }
    expect(Object.isFrozen(images)).toBe(false)
    expect(Object.isFrozen(browser)).toBe(false)
  })
})
