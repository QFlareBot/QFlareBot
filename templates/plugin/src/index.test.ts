import { describe, expect, it } from 'vitest'
import { runCommand } from '@qqbot/sdk/testing'
import plugin from './index.js'

describe('hello', () => {
  it('用默认配置回复问候语与参数', async () => {
    const session = await runCommand(plugin, 'hello', '世界')
    expect(session.replies).toEqual(['你好 世界'])
  })

  it('没有参数时只回复问候语', async () => {
    const session = await runCommand(plugin, 'hello')
    expect(session.replies).toEqual(['你好'])
  })

  it('使用面板保存的配置', async () => {
    const session = await runCommand(plugin, 'hello', 'Bob', { ctx: { config: { greeting: 'Hi' } } })
    expect(session.replies).toEqual(['Hi Bob'])
  })
})
