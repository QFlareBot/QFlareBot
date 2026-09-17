import { definePlugin } from '@qqbot/sdk'

interface Config {
  /** 连续回复的条数，QQ 对同一 msg_id 有上限 */
  count: number
  /** 每条之间的间隔（毫秒） */
  intervalMs: number
}

export default definePlugin<Config>({
  name: 'multi-reply',
  displayName: '连续回复',
  description: '对同一条消息连续被动回复多条，验证 msg_seq 由运行时集中分配',
  configSchema: {
    type: 'object',
    properties: {
      count: { type: 'integer', minimum: 1, maximum: 5, default: 3 },
      intervalMs: { type: 'integer', minimum: 0, default: 300 },
    },
  },
  defaultConfig: { count: 3, intervalMs: 300 },

  commands: {
    multi: {
      aliases: ['连续'],
      description: '连续回复 N 条',
      async handler({ session, ctx }) {
        const { count, intervalMs } = ctx.config
        for (let i = 1; i <= count; i++) {
          const result = await session.reply(`第 ${i}/${count} 条${i === count ? '，连续回复完成' : ''}`)
          if (!result.ok) {
            ctx.logger.warn('回复失败，停止', { seq: i, error: result.error })
            break
          }
          if (i < count && intervalMs) await new Promise((r) => setTimeout(r, intervalMs))
        }
      },
    },
  },
})
