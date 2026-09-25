import { describe, expect, it } from 'vitest'
import { definePlugin } from './plugin.js'
import { extractManifest, validateManifest } from './manifest.js'
import { toEventName, isMessageEvent } from './events.js'
import { runCommand } from './testing.js'

const plugin = definePlugin<{ greeting: string }>({
  name: 'demo',
  description: '示例',
  permissions: ['kv'],
  defaultConfig: { greeting: '你好' },
  commands: {
    hi: {
      aliases: ['hello'],
      description: '打招呼',
      async handler({ session, ctx, args }) {
        await session.reply(`${ctx.config.greeting} ${args.join(' ')}`.trim())
      },
    },
  },
  regex: [{ pattern: '^ping$', flags: 'i', handler: async ({ session }) => void session.reply('pong') }],
  events: [{ event: 'qq.group.robot_added', handler: async () => {} }],
  cron: [{ name: 'daily', cron: '0 9 * * *', handler: async () => {} }],
  routes: [{ method: 'GET', path: '/stats', handler: async () => new Response('ok') }],
  middleware: async (_input, next) => next(),
  services: { greeter: () => ({}) },
})

describe('extractManifest', () => {
  it('去掉函数只留数据，并补齐 version', () => {
    const m = extractManifest(plugin, { version: '1.2.3' })
    expect(m.version).toBe('1.2.3')
    expect(m.apiVersion).toBe(1)
    expect(m.commands).toEqual([{ name: 'hi', aliases: ['hello'], description: '打招呼' }])
    expect(m.regex).toEqual([{ pattern: '^ping$', flags: 'i' }])
    expect(m.events).toEqual([{ event: ['qq.group.robot_added'] }])
    expect(m.cron).toEqual([{ name: 'daily', cron: '0 9 * * *' }])
    expect(m.routes).toEqual([{ method: 'GET', path: '/stats' }])
    expect(m.hasMiddleware).toBe(true)
    expect(m.services).toEqual(['greeter'])
    expect(JSON.stringify(m)).not.toContain('handler')
  })

  it('缺 version 时报错', () => {
    expect(() => extractManifest({ name: 'x' })).toThrow('version')
  })
})

describe('validateManifest', () => {
  it('合法清单无错误', () => {
    expect(validateManifest(extractManifest(plugin, { version: '1.0.0' }))).toEqual([])
  })

  it('发现命令名重复、正则非法与 cron 段数错误', () => {
    const m = extractManifest(plugin, { version: '1.0.0' })
    m.commands.push({ name: 'hello' })
    m.regex.push({ pattern: '(' })
    m.cron.push({ name: 'bad', cron: '* * *' })
    const errors = validateManifest(m)
    expect(errors.some((e) => e.includes('命令名重复'))).toBe(true)
    expect(errors.some((e) => e.includes('正则非法'))).toBe(true)
    expect(errors.some((e) => e.includes('cron'))).toBe(true)
  })

  it('命令名按运行时的匹配规则查重：不分大小写、多个空白算一个', () => {
    const m = extractManifest(plugin, { version: '1.0.0' })
    m.commands.push({ name: 'pixiv random' }, { name: 'Pixiv  RANDOM' }, { name: 'pixiv illust' })
    expect(validateManifest(m).filter((e) => e.includes('命令名重复'))).toEqual(['命令名重复：Pixiv  RANDOM'])
  })
})

describe('events', () => {
  it('已知类型映射、未知类型落到 qq.raw.*', () => {
    expect(toEventName('GROUP_AT_MESSAGE_CREATE')).toBe('qq.group.at_message')
    expect(toEventName('SOMETHING_NEW')).toBe('qq.raw.something_new')
    expect(isMessageEvent('qq.c2c.message')).toBe(true)
    expect(isMessageEvent('qq.interaction')).toBe(false)
  })
})

describe('testing.runCommand', () => {
  it('直接驱动命令处理器并记录回复', async () => {
    const session = await runCommand(plugin, 'hi', '世界')
    expect(session.replies).toEqual(['你好 世界'])
  })
})

describe('keyboard builder', async () => {
  const { button, keyboard } = await import('./keyboard.js')
  it('生成符合平台结构的键盘', () => {
    const kb = keyboard([[button.command('图片', '/image', { enter: true }), button.callback('确认', 'ok', { id: 'confirm', style: 4, modal: '确定？' })], [button.link('文档', 'https://bot.q.qq.com')]])
    expect(kb).toEqual({
      content: {
        rows: [
          {
            buttons: [
              { render_data: { label: '图片' }, action: { type: 2, data: '/image', enter: true, permission: { type: 2 } } },
              { id: 'confirm', render_data: { label: '确认', style: 4 }, action: { type: 1, data: 'ok', permission: { type: 2 }, modal: { content: '确定？' } } },
            ],
          },
          { buttons: [{ render_data: { label: '文档' }, action: { type: 0, data: 'https://bot.q.qq.com', permission: { type: 2 } } }] },
        ],
      },
    })
  })
})

describe('buttons 清单', async () => {
  const { runButton } = await import('./testing.js')
  const p = definePlugin({
    name: 'btn',
    version: '1.0.0',
    buttons: {
      confirm: { dataPattern: '^ok', handler: async ({ session, buttonData }) => { await session.reply(`收到 ${buttonData}`); return 0 } },
      deny: { handler: async () => 4 },
    },
  })
  it('抽取与校验', () => {
    const m = extractManifest(p, {})
    expect(m.buttons).toEqual([{ id: 'confirm', dataPattern: '^ok' }, { id: 'deny' }])
    m.buttons.push({ id: 'bad', dataPattern: '(' })
    expect(validateManifest(m).some((e) => e.includes('dataPattern'))).toBe(true)
  })
  it('runButton 驱动处理器', async () => {
    const { session, code } = await runButton(p, 'confirm', 'ok:1')
    expect(session.replies).toEqual(['收到 ok:1'])
    expect(code).toBe(0)
    expect((await runButton(p, 'deny')).code).toBe(4)
  })
})

describe('权限与裸命令的清单透传', () => {
  it('bare 与 permission 进入清单供面板展示', () => {
    const p = definePlugin({
      name: 'perm',
      commands: { sign: { bare: true, permission: 'bot_admin', handler: () => 'ok' } },
      regex: [{ pattern: '^静言 (.+)$', permission: 'group_admin', handler: () => 'ok' }],
    })
    const m = extractManifest(p, { version: '1.0.0' })
    expect(m.commands).toEqual([{ name: 'sign', bare: true, permission: 'bot_admin' }])
    expect(m.regex).toEqual([{ pattern: '^静言 (.+)$', permission: 'group_admin' }])
    expect(validateManifest(m)).toEqual([])
  })
})
