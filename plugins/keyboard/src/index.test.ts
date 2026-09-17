import { runButton, runCommand } from '@qqbot/sdk/testing'
import { describe, expect, it } from 'vitest'
import plugin from './index.js'

describe('keyboard', () => {
  it('/panel 下发带键盘的消息', async () => {
    const session = await runCommand(plugin, 'panel')
    const msg = session.replies[0] as { keyboard: { content: { rows: Array<{ buttons: unknown[] }> } } }
    expect(msg.keyboard.content.rows).toHaveLength(4)
    expect(msg.keyboard.content.rows[2]!.buttons).toHaveLength(3)
  })

  it('回调按键分别回复 / 返回 code', async () => {
    const ping = await runButton(plugin, 'ping', 'ping')
    expect(ping.session.replies).toEqual(['收到回调，data = ping'])
    expect(ping.code).toBeUndefined()

    expect((await runButton(plugin, 'danger')).code).toBe(0)
    expect((await runButton(plugin, 'forbidden')).code).toBe(4)
  })
})
