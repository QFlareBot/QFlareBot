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
      description: '连续回复 N 条（可选参数，默认取配置，上限 5）',
      // 生成器：每 yield 一条就回复一条，msg_seq 由运行时编号
      async *handler({ ctx, argText }) {
        const { intervalMs } = ctx.config
        // 同一 msg_id 的被动回复平台最多 5 条，超出会被拒
        const count = Math.min(5, Math.max(1, parseInt(argText, 10) || ctx.config.count))
        for (let i = 1; i <= count; i++) {
          yield `第 ${i}/${count} 条${i === count ? '，连续回复完成' : ''}`
          if (i < count && intervalMs) await new Promise((r) => setTimeout(r, intervalMs))
        }
      },
    },
  },
})
