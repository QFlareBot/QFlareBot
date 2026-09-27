/**
 * 分发器的四条硬约束，全都只在「出问题的时候」才看得出来：
 *  - 收集候选阶段单个插件抛错，不能连带废掉整次分发
 *  - 插件正则带 g / y 也要取得到捕获组（`match[1]` 是写进契约的用法）
 *  - 回复投递失败必须留痕：失败计数本来就有（rt_events.failed），但没有归属也没有原因，
 *    SendResult 一丢就定位不到是哪个插件、哪条规则、平台回了什么
 *  - 分发链自己抛错时按钮仍要 ack，否则客户端一直转圈
 */
import { describe, expect, it } from 'vitest'
import { definePlugin, type Logger, type SendResult } from '@qqbot/sdk'
import { createMockSession } from '@qqbot/sdk/testing'
import type { ContextFactory } from './context.js'
import { dispatch, type DispatchDeps } from './dispatcher.js'
import { PluginRegistry } from './registry.js'
import type { RuntimeOptions, Snapshot } from './types.js'

const accepted = (): SendResult => ({ ok: true, status: 200, messageId: 'm1', raw: null })
const rejected = (): SendResult => ({ ok: false, status: 403, error: '内容审核未通过', raw: null })

function makeDeps(plugins: RuntimeOptions['plugins'], snapshot?: Snapshot) {
  const logged: Array<{ message: string; data?: unknown }> = []
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (message, data) => void logged.push({ message, data }),
  }
  const deps: DispatchDeps = {
    registry: new PluginRegistry(plugins),
    snapshot: snapshot ?? { revision: 1, plugins: {} },
    // 处理器只用到 match/session，ctx 给个空壳即可
    contexts: { prepare: async () => ({}) } as unknown as ContextFactory,
    commandPrefixes: ['/'],
    logger,
  }
  return { deps, logged }
}

describe('dispatch 的容错', () => {
  it('单个插件正则非法，只废掉它自己，其他插件照常执行', async () => {
    const bad = definePlugin({ name: 'bad', regex: { '(': () => 'x' } })
    const good = definePlugin({ name: 'good', commands: { hi: () => '你好' } })
    const { deps } = makeDeps([bad, good])
    const session = createMockSession({ content: '/hi' })

    const report = await dispatch(session, deps)

    expect(report.matched.map((m) => m.plugin)).toEqual(['good'])
    expect(report.errors).toHaveLength(1)
    expect(report.errors[0]).toMatchObject({ plugin: 'bad', stage: 'match' })
    expect(session.replies).toEqual(['你好'])
  })

  it('正则带 g 也能取到捕获组（String.match 带 g 时只返回整段匹配）', async () => {
    const plugin = definePlugin({ name: 'echoer', regex: { '/^echo (.+)$/g': ({ match }) => match[1]! } })
    const { deps } = makeDeps([plugin])
    const session = createMockSession({ content: 'echo 世界' })

    const report = await dispatch(session, deps)

    expect(report.matched).toEqual([{ plugin: 'echoer', kind: 'regex', name: '^echo (.+)$' }])
    expect(session.replies).toEqual(['世界'])
  })

  it('回复被平台拒收时记进 errors 并写日志，不再静默丢掉 SendResult', async () => {
    const plugin = definePlugin({ name: 'echoer', commands: { hi: () => '你好' } })
    const { deps, logged } = makeDeps([plugin])
    const session = createMockSession({ content: '/hi' })
    session.reply = async () => rejected()
    session.send = async () => rejected()

    const report = await dispatch(session, deps)

    expect(report.errors).toEqual([
      { plugin: 'echoer', stage: 'send:command:hi', message: '回复投递失败：HTTP 403（内容审核未通过）' },
    ])
    expect(logged.map((l) => l.message)).toEqual(['回复投递失败'])
  })

  it('成功投递不产生噪音', async () => {
    const plugin = definePlugin({ name: 'echoer', commands: { hi: () => '你好' } })
    const { deps, logged } = makeDeps([plugin])
    const session = createMockSession({ content: '/hi' })
    session.reply = async () => accepted()

    const report = await dispatch(session, deps)

    expect(report.errors).toEqual([])
    expect(logged).toEqual([])
  })

  it('分发链本身抛错时仍要 ack 按钮，否则客户端一直转圈', async () => {
    const plugin = definePlugin({ name: 'echoer', commands: { hi: () => '你好' } })
    // 畸形快照（KV 里的内容没有形状保证）：admins 不是数组，收集候选时在进入插件循环之前就会抛
    const { deps } = makeDeps([plugin], {
      revision: 1,
      plugins: {},
      admins: {} as unknown as string[],
    })
    const session = createMockSession({
      content: '/hi',
      event: 'qq.group.at_message',
      interaction: { type: 'button', buttonId: 'b1' },
    })

    const report = await dispatch(session, deps)

    expect(report.errors.map((e) => e.stage)).toEqual(['dispatch'])
    expect(session.acks).toEqual([0])
  })

  it('自动 ack 被平台拒收（返回 false 不抛错）时记进 errors 并写日志', async () => {
    const { deps, logged } = makeDeps([])
    const session = createMockSession({ interaction: { type: 'button', buttonId: 'b1' } })
    session.interaction!.ack = async () => false

    const report = await dispatch(session, deps)

    expect(report.errors).toEqual([{ plugin: 'runtime', stage: 'ack', message: expect.stringContaining('按钮回应失败') }])
    expect(logged.map((l) => l.message)).toEqual(['按钮回应失败'])
  })
})

describe('中间件的 next()', () => {
  it('调两次也只把后面的链跑一遍，两次拿到同一个 promise', async () => {
    const seen: boolean[] = []
    const twice = definePlugin({
      name: 'twice',
      middleware: async (_, next) => {
        const a = next()
        const b = next()
        seen.push(a === b)
        await a
        await b
      },
    })
    let runs = 0
    const echo = definePlugin({ name: 'echo', commands: { hi: () => `第 ${++runs} 次` } })
    const { deps } = makeDeps([twice, echo])
    const session = createMockSession({ content: '/hi' })

    const report = await dispatch(session, deps)

    expect(seen).toEqual([true])
    expect(session.replies).toEqual(['第 1 次'])
    expect(report.matched).toHaveLength(1)
  })

  it('调了 next() 没 await：分发等后半段跑完才结束，自动 ack 排在处理器之后', async () => {
    const order: string[] = []
    const lazy = definePlugin({
      name: 'lazy',
      middleware: async (_, next) => {
        void next()
      },
    })
    const slow = definePlugin({
      name: 'slow',
      buttons: {
        b1: async () => {
          await new Promise((r) => setTimeout(r, 5))
          order.push('handler')
          return '处理完了'
        },
      },
    })
    const { deps } = makeDeps([lazy, slow])
    const session = createMockSession({ interaction: { type: 'button', buttonId: 'b1' } })
    const ack = session.interaction!.ack.bind(session.interaction)
    session.interaction!.ack = async (code) => {
      order.push('ack')
      return ack(code)
    }

    const report = await dispatch(session, deps)

    expect(order).toEqual(['handler', 'ack'])
    expect(session.replies).toEqual(['处理完了'])
    expect(report.errors).toEqual([])
  })

  it('中间件调了 next() 后自己抛错：记在中间件头上，后半段不重跑也不丢', async () => {
    let runs = 0
    const flaky = definePlugin({
      name: 'flaky',
      middleware: async (_, next) => {
        void next()
        throw new Error('中间件坏了')
      },
    })
    const echo = definePlugin({ name: 'echo', commands: { hi: () => `第 ${++runs} 次` } })
    const { deps } = makeDeps([flaky, echo])
    const session = createMockSession({ content: '/hi' })

    const report = await dispatch(session, deps)

    expect(report.errors).toEqual([{ plugin: 'flaky', stage: 'middleware', message: '中间件坏了' }])
    expect(session.replies).toEqual(['第 1 次'])
  })

  it('await next() 拿到后半段的错误再抛出来：只记一次', async () => {
    const rethrow = definePlugin({
      name: 'rethrow',
      middleware: async (_, next) => {
        await next()
      },
    })
    const { deps } = makeDeps([rethrow], { revision: 1, plugins: {}, admins: {} as unknown as string[] })
    const session = createMockSession({ content: '/hi' })

    const report = await dispatch(session, deps)

    // 畸形快照让候选收集抛错；错误经 await next() 冒到中间件，按以前的规矩记在中间件头上
    expect(report.errors.map((e) => e.plugin)).toEqual(['rethrow'])
  })
})
