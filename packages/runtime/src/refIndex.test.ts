import { definePlugin, type QuotedMessage } from '@qqbot/sdk'
import { beforeEach, describe, expect, it } from 'vitest'
import { RefIndexTable } from './refIndex.js'
import { resetLifecycle } from './lifecycle.js'
import { createRuntime } from './runtime.js'
import { resetSnapshotCache } from './store.js'
import { createEnv, createExecutionContext, signedRequest } from './testing/mocks.js'

const G1 = { scene: 'group' as const, id: 'G1' }

describe('RefIndexTable', () => {
  it('按会话目标记、按会话目标查', () => {
    const table = new RefIndexTable()
    table.remember(G1, 'REFIDX_a', 'msg-a', 0)
    expect(table.lookup(G1, 'REFIDX_a', 1000)).toBe('msg-a')
    expect(table.lookup({ scene: 'group', id: 'G2' }, 'REFIDX_a', 1000)).toBeUndefined()
    expect(table.lookup({ scene: 'c2c', id: 'G1' }, 'REFIDX_a', 1000)).toBeUndefined()
  })

  it('2 分钟后查不到，过期的在下次记的时候清掉', () => {
    const table = new RefIndexTable()
    table.remember(G1, 'REFIDX_old', 'old', 0)
    expect(table.lookup(G1, 'REFIDX_old', 119_999)).toBe('old')
    expect(table.lookup(G1, 'REFIDX_old', 120_000)).toBeUndefined()

    table.remember(G1, 'REFIDX_x', 'x', 0)
    table.remember(G1, 'REFIDX_y', 'y', 130_000)
    expect(table.size).toBe(1)
    expect(table.lookup(G1, 'REFIDX_y', 130_000)).toBe('y')
  })

  it('缺目标、ref index 或消息 id 的不记；发送失败的不记', () => {
    const table = new RefIndexTable()
    table.remember({ scene: 'group', id: '' }, 'REFIDX_a', 'm')
    table.remember(G1, undefined, 'm')
    table.remember(G1, 'REFIDX_a', undefined)
    table.rememberSent(G1, { ok: false, status: 500, raw: null, messageId: 'm', refIndex: 'REFIDX_b' })
    table.rememberSent(G1, { ok: true, status: 200, raw: null, messageId: 'm' })
    expect(table.size).toBe(0)
    table.rememberSent(G1, { ok: true, status: 200, raw: null, messageId: 'm', refIndex: 'REFIDX_c' })
    expect(table.lookup(G1, 'REFIDX_c')).toBe('m')
  })

  it('超过条数上限先丢最早的', () => {
    const table = new RefIndexTable()
    for (let i = 0; i <= 5000; i++) table.remember(G1, `REFIDX_${i}`, `m${i}`, 0)
    expect(table.size).toBe(5000)
    expect(table.lookup(G1, 'REFIDX_0', 0)).toBeUndefined()
    expect(table.lookup(G1, 'REFIDX_5000', 0)).toBe('m5000')
  })
})

/** QQ 接口替身：发消息返回自增的 id 和 ref_idx（和线上一样放在 ext_info），其余请求只记下来 */
function fakeQQ() {
  const calls: Array<{ method: string; url: string }> = []
  let n = 0
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    const method = String(init?.method ?? 'GET')
    if (url.includes('getAppAccessToken')) return Response.json({ access_token: 'tok', expires_in: 7200 })
    calls.push({ method, url })
    if (method === 'POST' && url.endsWith('/messages')) {
      n += 1
      return Response.json({ id: `bot-msg-${n}`, ext_info: { ref_idx: `REFIDX_bot${n}` } })
    }
    return Response.json({})
  }
  return { fetchImpl, calls }
}

let seq = 0
/** 群里 U1 发的一条消息；refIdx 是它自己的 msg_idx，quoting 是它引用的那条的 ref index */
function groupMessage(content: string, refIdx: string, quoting?: string) {
  seq += 1
  return {
    op: 0,
    id: `GROUP_AT_MESSAGE_CREATE:e${seq}`,
    t: 'GROUP_AT_MESSAGE_CREATE',
    d: {
      id: `ROBOT1.0_m${seq}`,
      content: ` ${content}`,
      timestamp: new Date().toISOString(),
      author: { id: 'U1', member_openid: 'U1', username: '测试' },
      group_openid: 'G1',
      // 引用消息的形状照腾讯官方适配器 openclaw-qqbot 的类型：没有 message_reference，被引用那条只有 msg_idx 和原文
      message_scene: { source: 'default', ext: [`msg_idx=${refIdx}`, ...(quoting ? [`ref_msg_idx=${quoting}`] : [])] },
      ...(quoting && { message_type: 103, msg_elements: [{ msg_idx: quoting, content: '被引用的原文' }] }),
    },
  }
}

describe('引用消息补上被引用消息的 id（整条 webhook 链路）', () => {
  beforeEach(() => {
    resetSnapshotCache()
    resetLifecycle()
  })

  it('群友的消息、机器人的被动回复和 ctx.api 主动消息，引用后都能撤回；没见过的查不到', async () => {
    const quotes: Array<QuotedMessage | undefined> = []
    const plugin = definePlugin({
      name: 'recaller',
      version: '1.0.0',
      commands: {
        echo: async ({ session, ctx }) => {
          await session.reply('好')
          await ctx.api.sendMessage(G1, '主动')
        },
        recall: async ({ session }) => {
          quotes.push(session.quote)
          if (session.quote?.messageId) await session.recall(session.quote.messageId)
        },
      },
    })
    const qq = fakeQQ()
    const runtime = createRuntime({ plugins: [plugin], fetchImpl: qq.fetchImpl })
    const env = createEnv()
    const deliver = async (payload: object) => {
      const execCtx = createExecutionContext()
      await runtime.fetch!(await signedRequest('https://bot.test/webhook', payload), env, execCtx)
      await execCtx.flush()
    }

    const first = groupMessage('/echo', 'REFIDX_u1')
    await deliver(first)
    // 被动回复是 bot-msg-1（REFIDX_bot1），主动消息是 bot-msg-2（REFIDX_bot2）
    expect(qq.calls.filter((c) => c.method === 'POST')).toHaveLength(2)

    await deliver(groupMessage('/recall', 'REFIDX_r1', 'REFIDX_u1'))
    await deliver(groupMessage('/recall', 'REFIDX_r2', 'REFIDX_bot1'))
    await deliver(groupMessage('/recall', 'REFIDX_r3', 'REFIDX_bot2'))
    await deliver(groupMessage('/recall', 'REFIDX_r4', 'REFIDX_never'))

    expect(quotes.map((q) => q?.messageId)).toEqual([first.d.id, 'bot-msg-1', 'bot-msg-2', ''])
    expect(quotes[0]).toMatchObject({ content: '被引用的原文', refIndex: 'REFIDX_u1' })
    expect(qq.calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual([
      `https://api.bot.qq.com/v2/groups/G1/messages/${first.d.id}`,
      'https://api.bot.qq.com/v2/groups/G1/messages/bot-msg-1',
      'https://api.bot.qq.com/v2/groups/G1/messages/bot-msg-2',
    ])
  })
})
