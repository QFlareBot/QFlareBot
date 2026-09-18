import { button, definePlugin, keyboard, type PluginContext } from '@qqbot/sdk'
import { PAGE_HTML } from './page.js'

interface Config {
  /** URL 按键指向的地址 */
  docsUrl: string
}

interface Click {
  buttonId: string
  buttonData: string
  userId: string
  at: number
}

const CLICKS_KEY = 'clicks'
const MAX_CLICKS = 50

async function recordClick(ctx: PluginContext<Config>, click: Click) {
  const clicks = (await ctx.kv.getJSON<Click[]>(CLICKS_KEY)) ?? []
  clicks.unshift(click)
  await ctx.kv.put(CLICKS_KEY, clicks.slice(0, MAX_CLICKS))
}

/** 四种按键类型 × 多种样式的演示面板；回调按键由下方 `buttons` 接收 */
function showcase(docsUrl: string) {
  return keyboard([
    [
      button.command('自动发指令: 连续', '/连续', { enter: true, style: 1, visitedLabel: '已发送' }),
      button.command('自动发指令: 图片', '/图片', { enter: true, style: 1, visitedLabel: '已发送' }),
    ],
    [button.command('仅填充输入框', '这段文字不会自动发送', { enter: false })],
    [
      button.callback('服务端回调', 'ping', { id: 'ping', visitedLabel: '已触发' }),
      button.callback('危险操作', 'danger', { id: 'danger', style: 3, modal: '确定要执行吗？', visitedLabel: '已确认' }),
      button.callback('无权限演示', 'forbidden', { id: 'forbidden' }),
    ],
    [button.link('打开文档', docsUrl, { style: 1 })],
  ])
}

export default definePlugin<Config>({
  name: 'keyboard',
  displayName: '按键面板',
  description: '演示内嵌按键：指令 / 填充 / 回调 / 链接，以及回调按键的处理与回应',
  permissions: ['kv'],
  ui: { path: '/ui/', title: '按键点击记录' },
  configSchema: {
    type: 'object',
    properties: { docsUrl: { type: 'string', default: 'https://bot.q.qq.com/wiki/develop/api-v2/' } },
  },
  defaultConfig: { docsUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/' },

  commands: {
    panel: {
      aliases: ['按钮', '按键', 'button'],
      description: '下发按键演示面板',
      async handler({ session, ctx }) {
        await session.reply({
          text: '# 按键面板\n- 指令按键：点击替你发送指令\n- 填充按键：只填入输入框\n- 回调按键：触发服务端回调\n- 链接按键：打开网页',
          keyboard: showcase(ctx.config.docsUrl),
        })
      },
    },
  },

  buttons: {
    // 不返回 code：运行时自动以 0 回应平台
    ping: {
      async handler({ session, ctx, buttonId, buttonData }) {
        await recordClick(ctx, { buttonId, buttonData, userId: session.userId, at: Date.now() })
        await session.reply(`收到回调，data = ${buttonData}`)
      },
    },
    // 返回 code 作为对平台的回应
    danger: {
      async handler({ session, ctx, buttonId, buttonData }) {
        await recordClick(ctx, { buttonId, buttonData, userId: session.userId, at: Date.now() })
        ctx.logger.info('用户确认了危险操作', { user: session.userId })
        await session.reply('危险操作已执行')
        return 0
      },
    },
    // code 4：客户端提示"没有权限"，不再发消息
    forbidden: {
      async handler() {
        return 4
      },
    },
  },

  // 插件页面：HTML 由面板 iframe 打开，数据接口要求登录态（面板会通过桥接 token 提供）
  routes: [
    { method: 'GET', path: '/ui/*', auth: 'admin', handler: async () => new Response(PAGE_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } }) },
    {
      method: 'GET',
      path: '/api/clicks',
      auth: 'admin',
      handler: async ({ ctx }) => Response.json({ clicks: (await ctx.kv.getJSON<Click[]>(CLICKS_KEY)) ?? [] }),
    },
    {
      method: 'DELETE',
      path: '/api/clicks',
      auth: 'admin',
      handler: async ({ ctx }) => {
        await ctx.kv.delete(CLICKS_KEY)
        return Response.json({ ok: true })
      },
    },
  ],
})
