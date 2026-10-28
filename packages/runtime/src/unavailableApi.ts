/**
 * 机器人未配置时的占位 API。
 *
 * 单独成文件是因为两个地方要用：Worker 侧的 `RequestScope`（没配机器人时
 * 插件仍然要能跑，调 api 时拿到明确错误而不是崩）与 DO 侧的惰性客户端。
 * 两边行为必须一致，否则「为什么处理器里报错文案和 DO 里不一样」会很难查。
 */
import type { BotApi, GroupApi } from '@qqbot/sdk'

export const UNCONFIGURED_BOT_ERROR = '机器人尚未配置 AppID/AppSecret'

export function unavailableApi(): BotApi {
  const error = UNCONFIGURED_BOT_ERROR
  return {
    appId: '',
    raw: async () => {
      throw new Error(error)
    },
    uploadMedia: async () => {
      throw new Error(error)
    },
    sendMessage: async () => ({ ok: false, status: 0, error, raw: null }),
    // group 是属性不是方法，缺了会让 `api.group.xxx()` 炸在 "Cannot read properties of undefined"，
    // 那比 "尚未配置" 难查得多
    group: unavailableGroupApi(),
  } as unknown as BotApi
}

/** group 子对象的占位：每个方法都抛同一个可读错误 */
function unavailableGroupApi(): GroupApi {
  const error = UNCONFIGURED_BOT_ERROR
  const fail = async (): Promise<never> => {
    throw new Error(error)
  }
  return new Proxy({} as GroupApi, {
    get: (_target, prop) => {
      if (prop === 'then') return undefined
      return fail
    },
  })
}
