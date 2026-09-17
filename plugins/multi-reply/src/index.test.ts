import { runCommand } from '@qqbot/sdk/testing'
import { describe, expect, it } from 'vitest'
import plugin from './index.js'

describe('multi-reply', () => {
  it('按配置条数连续回复', async () => {
    const session = await runCommand(plugin, 'multi', '', { ctx: { config: { count: 2, intervalMs: 0 } } })
    expect(session.replies).toEqual(['第 1/2 条', '第 2/2 条，连续回复完成'])
  })
})
