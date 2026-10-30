/**
 * 分发器的硬约束，全都只在「出问题的时候」才看得出来：
 *  - 收集候选阶段单个插件抛错，不能连带废掉整次分发
 *  - 插件正则带 g / y 也要取得到捕获组（`match[1]` 是写进契约的用法）
 *  - 回复投递失败必须留痕：失败计数本来就有（rt_events.failed），但没有归属也没有原因，
 *    SendResult 一丢就定位不到是哪个插件、哪条规则、平台回了什么
 *  - 分发链自己抛错时按钮仍要 ack，否则客户端一直转圈
 *  - 同 priority 时命令排在事件前面：只靠注册顺序决定「命令先还是事件先」的话，
 *    装了哪些插件、按什么顺序装，都会改变语义（Agent 插件被这条坑过）
 *  - 命令因权限不足被拒也算「这条消息归命令」，不能再交给事件——
 *    否则普通成员发个 `/reset` 就被别的插件当成聊天处理掉了
 */
import { describe, expect, it } from 'vitest'
import { definePlugin, extractManifest, type Logger, type Manifest, type PluginDefinition, type SendResult } from '@qqbot/sdk'
import { createMockSession } from '@qqbot/sdk/testing'
import type { ContextFactory } from './context.js'
import { dispatch, type DispatchDeps } from './dispatcher.js'
import { PluginRegistry } from './registry.js'
import type { LazyPluginEntry, RuntimeOptions, Snapshot } from './types.js'

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
    const plugin = definePlugin({ name: 'echoer', commands: { hi: { permission: 'bot_admin', handler: () => '你好' } } })
    const { deps } = makeDeps([plugin])
    // 按插件兜住的范围之外抛错：权限不足时记调试日志，让日志出口抛
    deps.logger = { ...deps.logger, debug: () => { throw new Error('日志坏了') } }
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
    const guarded = definePlugin({ name: 'guarded', commands: { hi: { permission: 'bot_admin', handler: () => '你好' } } })
    const { deps } = makeDeps([rethrow, guarded])
    deps.logger = { ...deps.logger, debug: () => { throw new Error('日志坏了') } }
    const session = createMockSession({ content: '/hi' })

    const report = await dispatch(session, deps)

    // 权限不足记日志时抛错；错误经 await next() 冒到中间件，按以前的规矩记在中间件头上
    expect(report.errors.map((e) => e.plugin)).toEqual(['rethrow'])
  })
})

describe('按清单预筛：用不上的插件不加载', () => {
  /** 构建产物那样的懒加载条目：清单现成，代码 load() 时才求值；loads 记下谁被加载了 */
  function lazy(def: PluginDefinition<unknown>, loads: string[], manifest?: Partial<Manifest>): LazyPluginEntry {
    return {
      manifest: { ...extractManifest(def, { version: '1.0.0' }), ...manifest } as Manifest,
      load: async () => {
        loads.push(def.name)
        return { default: def }
      },
    }
  }

  function withPrepare(entries: RuntimeOptions['plugins'], snapshot?: Snapshot) {
    const { deps, logged } = makeDeps(entries, snapshot)
    const prepared: string[] = []
    deps.prepare = async (plugin) => void prepared.push(plugin.manifest.name)
    return { deps, logged, prepared }
  }

  it('命令只加载词对得上的插件，没命中的连 onBoot 都不跑', async () => {
    const loads: string[] = []
    const { deps, prepared } = withPrepare([
      lazy(definePlugin({ name: 'greeter', commands: { hi: () => '你好' } }), loads),
      lazy(definePlugin({ name: 'farewell', commands: { bye: () => '再见' } }), loads),
      lazy(definePlugin({ name: 'weather', regex: { '^天气': () => '晴' } }), loads),
      lazy(definePlugin({ name: 'welcome', events: { 'qq.group.member_added': () => '欢迎' } }), loads),
    ])
    const session = createMockSession({ content: '/hi' })

    const report = await dispatch(session, deps)

    expect(loads).toEqual(['greeter'])
    expect(prepared).toEqual(['greeter'])
    expect(session.replies).toEqual(['你好'])
    expect(report.matched).toEqual([{ plugin: 'greeter', kind: 'command', name: 'hi' }])
  })

  it('有中间件的每个事件都加载；正则、事件、按键各自按清单命中', async () => {
    const loads: string[] = []
    const entries = [
      lazy(definePlugin({ name: 'audit', middleware: async (_, next) => next() }), loads),
      lazy(definePlugin({ name: 'weather', regex: { '/^天气/i': () => '晴' } }), loads),
      lazy(definePlugin({ name: 'welcome', events: { 'qq.group.member_added': () => '欢迎' } }), loads),
      lazy(definePlugin({ name: 'vote', buttons: { yes: { dataPattern: '^poll:', handler: () => 0 } } }), loads),
    ]

    await dispatch(createMockSession({ content: '天气怎么样' }), withPrepare(entries).deps)
    expect(loads.sort()).toEqual(['audit', 'weather'])

    loads.length = 0
    await dispatch(createMockSession({ event: 'qq.group.member_added', content: '' }), withPrepare(entries).deps)
    expect(loads.sort()).toEqual(['audit', 'welcome'])

    loads.length = 0
    const click = (buttonData: string) =>
      createMockSession({ event: 'qq.interaction', content: '', interaction: { type: 'button', buttonId: 'yes', buttonData } })
    await dispatch(click('poll:1'), withPrepare(entries).deps)
    expect(loads.sort()).toEqual(['audit', 'vote'])
    loads.length = 0
    await dispatch(click('other'), withPrepare(entries).deps)
    expect(loads).toEqual(['audit'])
  })

  it('没 @ 机器人的群消息只加载 bare 命令；@ 了就都参与', async () => {
    const loads: string[] = []
    const entries = [
      lazy(definePlugin({ name: 'plain', commands: { 签到: () => '已签到' } }), loads),
      lazy(definePlugin({ name: 'loose', commands: { 签到: { bare: true, handler: () => 'bare 签到' } } }), loads),
    ]
    await dispatch(createMockSession({ content: '签到', atMe: false }), withPrepare(entries).deps)
    expect(loads).toEqual(['loose'])

    loads.length = 0
    await dispatch(createMockSession({ content: '签到', atMe: true }), withPrepare(entries).deps)
    expect(loads.sort()).toEqual(['loose', 'plain'])
  })

  it('权限不足的命令也要加载：它要参与「最长命令名胜出」和统一的权限不足回复', async () => {
    const loads: string[] = []
    const entries = [
      lazy(definePlugin({ name: 'pixiv', commands: { pixiv: () => '父命令' } }), loads),
      lazy(definePlugin({ name: 'pixiv-admin', commands: { 'pixiv random': { permission: 'bot_admin', handler: () => '子命令' } } }), loads),
    ]
    const { deps } = withPrepare(entries, { revision: 1, plugins: {}, permissionDeniedReply: '没有权限' })
    const session = createMockSession({ content: '/pixiv random' })

    const report = await dispatch(session, deps)

    expect(loads.sort()).toEqual(['pixiv', 'pixiv-admin'])
    // 子命令权限不足也不退回父命令，统一回复补一句
    expect(report.matched).toEqual([])
    expect(session.replies).toEqual(['没有权限'])
  })

  it('用得上的插件依赖的服务提供者也要准备（onInstall / onBoot），但不参与这次匹配', async () => {
    const loads: string[] = []
    const provider = definePlugin({ name: 'store', services: { kv2: () => ({}) }, commands: { store: () => '不该执行' } })
    const base = definePlugin({ name: 'base', services: { log2: () => ({}) } })
    const consumer = definePlugin({ name: 'shop', depends: { kv2: '*' }, commands: { buy: () => '买了' } })
    // 提供者自己也依赖别人：顺着往下找
    const providerWithDeps = { ...provider, depends: { log2: '*' } }
    const { deps, prepared } = withPrepare([lazy(providerWithDeps, loads), lazy(base, loads), lazy(consumer, loads)])
    const session = createMockSession({ content: '/buy' })

    const report = await dispatch(session, deps)

    expect(loads.sort()).toEqual(['base', 'shop', 'store'])
    expect(prepared.sort()).toEqual(['base', 'shop', 'store'])
    expect(report.matched).toEqual([{ plugin: 'shop', kind: 'command', name: 'buy' }])
  })

  it('清单缺字段（旧制品来源）或正则编译不了：宁可多加载，交给收集候选照旧处理', async () => {
    const loads: string[] = []
    const { deps } = withPrepare([
      lazy(definePlugin({ name: 'legacy', commands: { other: () => 'x' } }), loads, { hasMiddleware: undefined as unknown as boolean }),
      lazy(definePlugin({ name: 'broken', regex: { '(': () => 'x' } }), loads),
      lazy(definePlugin({ name: 'unrelated', commands: { other: () => 'x' } }), loads),
    ])

    const report = await dispatch(createMockSession({ content: '/hi' }), deps)

    expect(loads.sort()).toEqual(['broken', 'legacy'])
    // 坏正则照旧只废掉它自己，错误记在它头上
    expect(report.errors).toEqual([expect.objectContaining({ plugin: 'broken', stage: 'match' })])
  })

  it('停用与本群不生效的插件照旧不加载', async () => {
    const loads: string[] = []
    const entries = [
      lazy(definePlugin({ name: 'off', commands: { hi: () => 'x' } }), loads),
      lazy(definePlugin({ name: 'elsewhere', commands: { hi: () => 'y' } }), loads),
    ]
    const snapshot: Snapshot = {
      revision: 1,
      plugins: { off: { enabled: false }, elsewhere: { enabled: true, groups: { mode: 'allow', ids: ['other-group'] } } },
    }
    await dispatch(createMockSession({ content: '/hi', scene: 'group', targetId: 'g1' }), withPrepare(entries, snapshot).deps)
    expect(loads).toEqual([])
  })
})

/**
 * 命令与消息事件的关系：一条命令消息只该归命令，不该再被「被动监听事件」的插件
 * 当成聊天处理一次。
 *
 * 历史坑：命令默认 `block: true`，但「阻止后续匹配器」只对**排在它之后**的候选成立。
 * 同 priority 时按注册顺序排，于是「事件插件先注册」的部署里，一条 `/weather` 会先被
 * 事件处理器当成聊天、命令才跑——表现是「有时命令先、有时事件先」，取决于装了哪些插件、
 * 按什么顺序装。Agent 插件正是受害者：它把 `/xxx` 当唤醒前缀剥掉送进模型。
 */
describe('命令与消息事件的执行顺序', () => {
  /** 记下谁跑了；顺序也记，用来断言「命令在前」 */
  const listener = (ran: string[]) =>
    definePlugin({ name: 'listener', events: { 'qq.group.message': () => void ran.push('event') } })
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  it('事件插件先注册时，命令仍然先跑并 block 掉事件', async () => {
    const ran: string[] = []
    const weather = definePlugin({ name: 'weather', commands: { weather: () => void ran.push('command') } })
    const session = createMockSession({ event: 'qq.group.message', content: '/weather 北京' })

    await dispatch(session, makeDeps([listener(ran), weather]).deps)

    expect(ran).toEqual(['command'])
  })

  it('命令先注册时同样只跑命令（顺序不该由注册顺序决定）', async () => {
    const ran: string[] = []
    const weather = definePlugin({ name: 'weather', commands: { weather: () => void ran.push('command') } })
    const session = createMockSession({ event: 'qq.group.message', content: '/weather 北京' })

    await dispatch(session, makeDeps([weather, listener(ran)]).deps)

    expect(ran).toEqual(['command'])
  })

  it('命令显式 block:false 时事件照跑（保持兼容）', async () => {
    const ran: string[] = []
    const both = definePlugin({ name: 'both', commands: { hi: { block: false, handler: () => void ran.push('command') } } })
    const session = createMockSession({ event: 'qq.group.message', content: '/hi' })

    await dispatch(session, makeDeps([both, listener(ran)]).deps)

    expect(ran).toEqual(['command', 'event'])
  })

  it('没有命令命中时事件照跑（原行为）', async () => {
    const ran: string[] = []
    const weather = definePlugin({ name: 'weather', commands: { weather: () => void ran.push('command') } })
    const session = createMockSession({ event: 'qq.group.message', content: '随便聊聊' })

    await dispatch(session, makeDeps([weather, listener(ran)]).deps)

    expect(ran).toEqual(['event'])
  })

  it('正则命中但不 block（默认 false）时事件照跑（保持兼容）', async () => {
    const ran: string[] = []
    const re = definePlugin({ name: 're', regex: { '^天气$': () => void ran.push('regex') } })
    const session = createMockSession({ event: 'qq.group.message', content: '天气' })

    await dispatch(session, makeDeps([re, listener(ran)]).deps)

    expect(ran).toEqual(['regex', 'event'])
  })

  it('事件显式声明更高 priority 时仍能抢到前面（显式意图不被压平）', async () => {
    const ran: string[] = []
    const observer = definePlugin({
      name: 'observer',
      events: { 'qq.group.message': { priority: 10, handler: () => void ran.push('event') } },
    })
    const weather = definePlugin({ name: 'weather', commands: { weather: () => void ran.push('command') } })
    const session = createMockSession({ event: 'qq.group.message', content: '/weather 北京' })

    await dispatch(session, makeDeps([observer, weather]).deps)

    expect(ran).toEqual(['event', 'command'])
  })

  it('命令因权限不足被拒时，事件也不接手（权限不够也算消费）', async () => {
    const ran: string[] = []
    const guarded = definePlugin({
      name: 'guarded',
      commands: { reset: { permission: 'group_admin', handler: () => void ran.push('command') } },
    })
    const session = createMockSession({ event: 'qq.group.message', content: '/reset', memberRole: 'member' })

    const report = await dispatch(session, makeDeps([listener(ran), guarded]).deps)

    expect(ran).toEqual([])
    expect(report.matched).toEqual([])
  })

  it('权限不足的命令不再遮蔽统一回复：没有候选命中时仍补「没有权限」', async () => {
    const ran: string[] = []
    const guarded = definePlugin({
      name: 'guarded',
      commands: { reset: { permission: 'group_admin', handler: () => void ran.push('command') } },
    })
    const session = createMockSession({ event: 'qq.group.message', content: '/reset', memberRole: 'member' })
    const { deps } = makeDeps([listener(ran), guarded], { revision: 1, plugins: {}, permissionDeniedReply: '没有权限' })

    await dispatch(session, deps)

    expect(ran).toEqual([])
    expect(session.replies).toEqual(['没有权限'])
  })

  it('被拒的命令不该挡住别的插件的正则与按键（只跳过事件）', async () => {
    const ran: string[] = []
    const guarded = definePlugin({
      name: 'guarded',
      commands: { reset: { permission: 'group_admin', handler: () => void ran.push('command') } },
    })
    const re = definePlugin({ name: 're', regex: { 'reset': () => void ran.push('regex') } })
    const session = createMockSession({ event: 'qq.group.message', content: '/reset', memberRole: 'member' })

    await dispatch(session, makeDeps([guarded, re, listener(ran)]).deps)

    expect(ran).toEqual(['regex'])
  })

  it('一个插件的命令被拒，不影响另一个插件同名命令照常执行', async () => {
    const ran: string[] = []
    const strict = definePlugin({
      name: 'strict',
      commands: { reset: { permission: 'bot_admin', handler: () => void ran.push('strict') } },
    })
    const loose = definePlugin({ name: 'loose', commands: { reset: () => void ran.push('loose') } })
    const session = createMockSession({ event: 'qq.group.message', content: '/reset' })

    await dispatch(session, makeDeps([strict, loose]).deps)

    // 只有严格的那个被拒；宽松的那个照常跑，也不会退回去让事件接手
    expect(ran).toEqual(['loose'])
  })

  it('子命令权限不足时不退回父命令，事件也不接手（权限不足仍算消费）', async () => {
    const ran: string[] = []
    const parent = definePlugin({ name: 'parent', commands: { pixiv: () => void ran.push('parent') } })
    const child = definePlugin({
      name: 'child',
      commands: { 'pixiv random': { permission: 'bot_admin', handler: () => void ran.push('child') } },
    })
    const session = createMockSession({ event: 'qq.group.message', content: '/pixiv random 大图' })

    await dispatch(session, makeDeps([parent, child, listener(ran)]).deps)

    expect(ran).toEqual([])
  })

  it('同一插件里命令与事件并存时只跑命令（Agent 插件的真实形态）', async () => {
    const ran: string[] = []
    const agent = definePlugin({
      name: 'agent',
      commands: { reset: () => void ran.push('command') },
      events: { 'qq.group.message': () => void ran.push('event') },
    })
    const session = createMockSession({ event: 'qq.group.message', content: '/reset' })

    await dispatch(session, makeDeps([agent]).deps)

    expect(ran).toEqual(['command'])
  })

  it('中间件里拦下的消息不触发任何匹配器（与顺序改动无关，防回归）', async () => {
    const ran: string[] = []
    const guard = definePlugin({ name: 'guard', middleware: async () => void ran.push('middleware') })
    const weather = definePlugin({ name: 'weather', commands: { weather: () => void ran.push('command') } })
    const session = createMockSession({ event: 'qq.group.message', content: '/weather 北京' })

    await dispatch(session, makeDeps([guard, weather, listener(ran)]).deps)

    expect(ran).toEqual(['middleware'])
  })

  it('事件处理器慢时，命令的结果仍然先产生（顺序断言不依赖时序噪声）', async () => {
    const ran: string[] = []
    const slow = definePlugin({
      name: 'slow',
      events: { 'qq.group.message': async () => { await sleep(1); ran.push('event') } },
    })
    const weather = definePlugin({ name: 'weather', commands: { weather: () => void ran.push('command') } })
    const session = createMockSession({ event: 'qq.group.message', content: '/weather 北京' })

    await dispatch(session, makeDeps([slow, weather]).deps)

    expect(ran).toEqual(['command'])
  })
})
