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
