import { definePlugin } from '@qqbot/sdk'
import { createRecordingApi } from '@qqbot/sdk/testing'
import { describe, expect, it, vi } from 'vitest'
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

describe('可选的 Cloudflare 绑定', () => {
  it('绑定了就是 env 上的原对象', () => {
    const images = {} as ImagesBinding
    const browser = {} as BrowserRun
    const ctx = contextOf(createEnv({ IMAGES: images, BROWSER: browser }))
    expect(ctx.images).toBe(images)
    expect(ctx.browser).toBe(browser)
  })

  it('ctx.email 把结构化邮件交给 EMAIL 并返回发送结果', async () => {
    const result = { messageId: 'test-message' }
    const email: SendEmail = { send: vi.fn().mockResolvedValue(result) }
    const ctx = contextOf(createEnv({ EMAIL: email }))
    const message = { from: 'bot@example.org', to: 'member@example.org', subject: '课程提醒', text: '课程即将开始' }
    expect(ctx.email).toBe(email)
    await expect(ctx.email!.send(message)).resolves.toEqual(result)
    expect(email.send).toHaveBeenCalledWith(message)
  })

  it('没绑定时是 undefined', () => {
    const ctx = contextOf(createEnv())
    expect(ctx.images).toBeUndefined()
    expect(ctx.browser).toBeUndefined()
    expect(ctx.email).toBeUndefined()
  })
})
