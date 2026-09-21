import { definePlugin } from '@qqbot/sdk'
import { T2I } from './t2i.js'
import type { T2IConfig } from './t2i.js'
import { DEFAULT_T2I_URL } from './t2i.js'
import { PAGE_HTML } from './page.js'

// 供其他插件 `import type { T2I, ... } from 'qqbot-plugin-t2i'` 使用
export { DEFAULT_T2I_URL, T2I } from './t2i.js'
export type {
  T2IConfig,
  T2IOptions,
  T2IPingResult,
  T2IRenderBase64Result,
  T2IRenderOptions,
  T2IRenderResult,
} from './t2i.js'

/** 面板配置（configSchema / defaultConfig 的形状） */
export interface PluginConfig {
  /** AstrBot T2I 服务基地址 */
  t2i_url: string
  /** 渲染超时毫秒数 */
  t2i_timeout: number
}

/** 从面板配置构造 T2I 客户端（服务与页面路由共用） */
function t2iFromConfig(config: PluginConfig): T2I {
  return new T2I({ url: config.t2i_url, timeoutMs: config.t2i_timeout })
}

export default definePlugin<PluginConfig>({
  name: 't2i',
  displayName: 'T2I 渲染',
  description: 'AstrBot T2I 渲染服务：把 HTML 渲染成图片；向其他插件导出 t2i 服务，页面可测连通性与试渲染',
  permissions: ['net'],
  ui: { path: '/ui/', title: 'T2I 渲染服务' },

  configSchema: {
    type: 'object',
    properties: {
      t2i_url: {
        type: 'string',
        title: 'AstrBot T2I 服务端点',
        description: 'T2I 服务基地址，需支持 POST /text2img/generate',
        default: DEFAULT_T2I_URL,
      },
      t2i_timeout: {
        type: 'integer',
        title: '渲染超时时间 (毫秒)',
        description: '调用 T2I 服务的最大等待时间，默认 25000ms',
        default: 25000,
        minimum: 5000,
        maximum: 120000,
      },
    },
  },

  defaultConfig: {
    t2i_url: DEFAULT_T2I_URL,
    t2i_timeout: 25000,
  },

  // 向其他插件提供服务：depends 声明 `{ t2i: '*' }` 后 ctx.service<T2I>('t2i')
  services: {
    t2i: (ctx) => t2iFromConfig(ctx.config),
  },

  // 插件页面：服务状态、连通性测试与试渲染
  routes: [
    {
      method: 'GET',
      path: '/ui/*',
      auth: 'admin',
      handler: async () => new Response(PAGE_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    },
    {
      method: 'GET',
      path: '/api/config',
      auth: 'admin',
      handler: async ({ ctx }) =>
        Response.json({
          endpoint: t2iFromConfig(ctx.config).endpoint,
          timeoutMs: ctx.config.t2i_timeout,
        }),
    },
    {
      method: 'POST',
      path: '/api/test',
      auth: 'admin',
      handler: async ({ ctx }) => Response.json(await t2iFromConfig(ctx.config).ping()),
    },
    {
      method: 'POST',
      path: '/api/render',
      auth: 'admin',
      handler: async ({ ctx, request }) => {
        const { html, width, height } = (await request.json().catch(() => ({}))) as {
          html?: string
          width?: number
          height?: number
        }
        if (!html || !html.trim()) return Response.json({ ok: false, error: 'html 不能为空' }, { status: 400 })
        const startedAt = Date.now()
        try {
          const { base64, byteSize } = await t2iFromConfig(ctx.config).renderBase64(html, {
            width: width ?? 480,
            height: height ?? 640,
          })
          return Response.json({ ok: true, base64, byteSize, latencyMs: Date.now() - startedAt })
        } catch (err: unknown) {
          return Response.json(
            { ok: false, error: err instanceof Error ? err.message : String(err) },
            { status: 502 },
          )
        }
      },
    },
  ],
})
