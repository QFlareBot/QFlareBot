import { definePlugin } from '@qqbot/sdk'

/** 与 configSchema 对应；面板保存的配置通过 ctx.config 注入 */
export interface Config {
  greeting: string
}

export default definePlugin<Config>({
  // 与 npm 包名一致，安装后作为 KV / 表前缀与路由前缀
  name: 'qqbot-plugin-example',
  displayName: '示例插件',
  description: '演示命令、正则与事件的最小插件',
  permissions: ['proactive'],

  configSchema: {
    type: 'object',
    properties: {
      greeting: { type: 'string', title: '问候语', default: '你好' },
    },
    required: ['greeting'],
  },
  defaultConfig: { greeting: '你好' },

  commands: {
    hello: {
      description: '打招呼',
      usage: '/hello [名字]',
      async handler({ session, ctx, argText }) {
        await session.reply(`${ctx.config.greeting} ${argText}`.trim())
      },
    },
  },

  regex: [
    {
      pattern: '^ping$',
      flags: 'i',
      async handler({ session }) {
        await session.reply('pong')
      },
    },
  ],

  events: [
    {
      event: 'qq.group.robot_added',
      async handler({ session, ctx }) {
        ctx.logger.info('机器人被加入群聊', { group: session.targetId })
        await session.send(`${ctx.config.greeting}，我是示例机器人，发送 /hello 试试`)
      },
    },
  ],
})
