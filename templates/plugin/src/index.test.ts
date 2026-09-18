import { describe, expect, it } from 'vitest'
import { runButton, runCommand } from '@qqbot/sdk/testing'
import plugin from './index.js'

describe('example plugin', () => {
  it('hello 用默认配置回复问候语与参数', async () => {
    expect((await runCommand(plugin, 'hello', '世界')).replies).toEqual(['你好 世界'])
    expect((await runCommand(plugin, 'hello')).replies).toEqual(['你好'])
  })

  it('使用面板保存的配置', async () => {
    const session = await runCommand(plugin, 'hello', 'Bob', { ctx: { config: { greeting: 'Hi' } } })
    expect(session.replies).toEqual(['Hi Bob'])
  })

  it('生成器逐条回复', async () => {
    expect((await runCommand(plugin, 'count', '2')).replies).toEqual(['1', '2'])
  })

  it('按键回调返回消息', async () => {
    const { session, code } = await runButton(plugin, 'confirm', 'yes')
    expect(session.replies).toEqual(['已确认（yes）'])
    expect(code).toBeUndefined()
  })
})
