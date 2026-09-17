import { runCommand } from '@qqbot/sdk/testing'
import { describe, expect, it } from 'vitest'
import plugin from './index.js'

describe('echo', () => {
  it('带前缀回显参数', async () => {
    const session = await runCommand(plugin, 'echo', '你好', { ctx: { config: { prefix: '> ' } } })
    expect(session.replies).toEqual(['> 你好'])
  })

  it('无参数时提示', async () => {
    const session = await runCommand(plugin, 'echo')
    expect(session.replies[0]).toContain('说什么')
  })
})
