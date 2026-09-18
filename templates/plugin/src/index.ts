import { button, definePlugin, keyboard } from '@qqbot/sdk'

/** 与 configSchema 对应；面板保存的配置通过 ctx.config 注入 */
export interface Config {
  greeting: string
}

export default definePlugin<Config>({
  // 包名去掉 qqbot-plugin- 前缀的短名，同时是 KV 前缀、D1 表前缀与路由 /p/<name>/
  // 构建时会校验它与 package.json 的 name 对得上
  name: 'example',
  displayName: '示例插件',
  description: '演示命令、正则、事件与按键的最小插件',
  // 仅供安装前展示，运行时不强制（插件与核心同 isolate，无法沙箱）
  permissions: ['kv'],

  configSchema: {
    type: 'object',
    properties: {
      greeting: { type: 'string', title: '问候语', default: '你好' },
    },
    required: ['greeting'],
  },
  defaultConfig: { greeting: '你好' },

  commands: {
    // 最简形式：函数的返回值就是回复（字符串或消息对象）
    hello: ({ ctx, argText }) => `${ctx.config.greeting} ${argText}`.trim(),

    // 需要描述、别名、优先级时用对象形式；生成器可以连续回复多条
    count: {
      description: '数到 N',
      usage: '/count [N]',
      aliases: ['数数'],
      async *handler({ args }) {
        const n = Math.min(5, Number(args[0]) || 3)
        for (let i = 1; i <= n; i++) yield `${i}`
      },
    },

    // 带按键的消息：keyboard 会自动把消息升级为 markdown
    menu: () => ({
      text: '选一个：',
      keyboard: keyboard([[button.callback('确认', 'yes', { id: 'confirm' }), button.command('再来一次', '/menu', { enter: true })]]),
    }),

    // 需要更多控制时直接用 session / ctx，不返回即可
    remember: async ({ session, ctx, argText }) => {
      await ctx.kv.put(`note:${session.userId}`, argText)
      await session.reply('记住了')
    },
  },

  // 以模式为键；`/…/i` 形式可带 flags
  regex: {
    '/^ping$/i': () => 'pong',
  },

  // 以事件名为键；入群事件支持 event_id 被动回复，不消耗主动消息额度
  events: {
    'qq.group.robot_added': ({ ctx }) => `${ctx.config.greeting}，我是示例机器人，发送 /hello 试试`,
  },

  // 回调按键：key 是发送时设置的按键 id。返回消息即回复；返回数字则作为回应平台的 code
  buttons: {
    confirm: ({ buttonData }) => `已确认（${buttonData}）`,
  },
})
