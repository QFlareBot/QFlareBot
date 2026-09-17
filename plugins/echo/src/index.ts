import { definePlugin } from '@qqbot/sdk'

interface Config {
  /** 回显前缀 */
  prefix: string
}

export default definePlugin<Config>({
  name: 'echo',
  displayName: '回显',
  description: '回显消息；/proactive 演示脱离 msg_id 的主动推送',
  permissions: ['proactive'],
  configSchema: {
    type: 'object',
    properties: { prefix: { type: 'string', title: '回显前缀', default: '' } },
  },
  defaultConfig: { prefix: '' },

  commands: {
    echo: {
      description: '原样回复你发的内容',
      usage: '/echo <文本>',
      async handler({ session, ctx, argText }) {
        await session.reply(argText ? `${ctx.config.prefix}${argText}` : '你想让我说什么？')
      },
    },
    proactive: {
      description: '先被动回复，再主动推送一条消息',
      async handler({ session, ctx }) {
        await session.reply('收到，2 秒后主动推送一条消息')
        await new Promise((r) => setTimeout(r, 2000))
        const result = await session.send(`主动消息 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`)
        if (!result.ok) ctx.logger.warn('主动消息失败', { error: result.error, scene: session.scene })
      },
    },
  },

  events: [
    {
      event: 'qq.group.robot_added',
      // 入群事件支持 event_id 被动回复，不消耗主动消息额度
      async handler({ session }) {
        await session.reply('大家好，发送 /echo 试试')
      },
    },
  ],
})
