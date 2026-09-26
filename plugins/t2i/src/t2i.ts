/**
 * AstrBot T2I 渲染客户端。
 *
 * 本插件是纯服务型插件：`services.t2i` 把 `T2I` 类实例导出给其他插件，
 * URL 与超时来自本插件的面板配置，运行时按请求重建实例，改配置即刻生效。
 * 其他插件在 `depends` 声明 `t2i: '*'` 后 `ctx.service<T2I>('t2i')` 即可把
 * 任意 HTML 渲染成图片，不必各自对接 T2I 节点。
 */

/** 单次渲染的可调参数，不传则用构造时的默认值 */
export interface T2IOptions {
  /** 图片格式，默认 jpeg */
  type?: 'jpeg' | 'png' | 'webp'
  /** jpeg / webp 质量 1-100，默认 85 */
  quality?: number
  /** 视口宽度，默认 1080。注意：服务端有 1280x720 的视口下限，低于下限会被抬高（2026-09 实测） */
  width?: number
  /** 视口高度（full_page 时为首屏高度），默认 1920。同样受 720 的下限钳制 */
  height?: number
  /** 是否整页截图，默认 true */
  fullPage?: boolean
  /** 本次调用的超时毫秒数，覆盖构造时的默认值 */
  timeoutMs?: number
}

export interface T2IRenderOptions extends T2IOptions {}

export interface T2IRenderResult {
  /** 图片二进制 */
  data: ArrayBuffer
  /** 响应的 content-type（如 image/jpeg） */
  contentType: string
  byteSize: number
}

export interface T2IRenderBase64Result {
  /** 可直接放进 `{ image: { base64 } }` 回复消息 */
  base64: string
  byteSize: number
}

export interface T2IRenderUrlResult {
  /** 图片存在 T2I 服务上，可直接放进 `{ image: { url } }` 交给 QQ 拉取 */
  url: string
}

export interface T2IPingResult {
  ok: boolean
  /** 端到端渲染耗时（毫秒）；失败时为 0 */
  latencyMs: number
  error?: string
}

export interface T2IConfig {
  /** T2I 服务基地址，如 https://xxx.hf.space */
  url: string
  /** 默认超时毫秒数，默认 25000 */
  timeoutMs?: number
}

/** ArrayBuffer 转 Base64（分块处理，防止大文件爆调用栈） */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000 // 32KB
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length))
    binary += String.fromCharCode.apply(null, chunk as unknown as number[])
  }
  return btoa(binary)
}

/** 默认 T2I 服务基地址：configSchema 默认值 / defaultConfig / 构造器兜底共用一处 */
export const DEFAULT_T2I_URL = 'https://clown145-astrbot-t2i-service.hf.space'

const DEFAULT_TIMEOUT_MS = 25000

export class T2I {
  private readonly baseUrl: string
  private readonly defaultTimeoutMs: number

  constructor(config: T2IConfig) {
    this.baseUrl = (config.url || DEFAULT_T2I_URL).replace(/\/+$/, '')
    this.defaultTimeoutMs = config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS
  }

  /** 渲染端点（POST /text2img/generate） */
  get endpoint(): string {
    return `${this.baseUrl}/text2img/generate`
  }

  /**
   * POST /text2img/generate。`json` 为 false 时响应体就是图片；为 true 时服务端把图存下来，
   * 只回 `{ code, message, data: { id } }`，图片在 `<服务地址>/text2img/<id>`（2026-09 实测）。
   * 超时覆盖读响应体的时间。
   */
  private async generate<T>(
    html: string,
    options: T2IRenderOptions,
    json: boolean,
    read: (response: Response) => Promise<T>,
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          html,
          json,
          options: {
            type: options.type ?? 'jpeg',
            quality: options.quality ?? 85,
            full_page: options.fullPage ?? true,
            viewport: {
              width: options.width ?? 1080,
              height: options.height ?? 1920,
            },
          },
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const errorText = await response.text().catch(() => '')
        throw new Error(`T2I 服务响应错误 (HTTP ${response.status}): ${errorText.slice(0, 300)}`)
      }
      return await read(response)
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`T2I 渲染超时 (${timeoutMs}ms)，请检查 T2I 节点健康状态`)
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  /** HTML → 图片二进制 */
  async render(html: string, options: T2IRenderOptions = {}): Promise<T2IRenderResult> {
    return this.generate(html, options, false, async (response) => {
      const data = await response.arrayBuffer()
      if (!data || data.byteLength === 0) {
        throw new Error('T2I 服务返回了空数据')
      }
      return {
        data,
        contentType: response.headers.get('content-type') ?? 'image/jpeg',
        byteSize: data.byteLength,
      }
    })
  }

  /**
   * HTML → 图片地址：图存在 T2I 服务上，QQ 直接去拉，图片字节不经过 Worker。
   * 发图优先用它；renderBase64 要在 Worker 里编码，吃的是全机器人共享的 CPU
   */
  async renderUrl(html: string, options: T2IRenderOptions = {}): Promise<T2IRenderUrlResult> {
    return this.generate(html, options, true, async (response) => {
      const body = (await response.json().catch(() => null)) as { message?: unknown; data?: { id?: unknown } } | null
      const id = body?.data?.id
      if (typeof id !== 'string' || !id) {
        throw new Error(`T2I 服务没有返回图片地址${typeof body?.message === 'string' ? `: ${body.message.slice(0, 300)}` : ''}`)
      }
      return { url: `${this.baseUrl}/text2img/${id.replace(/^\/+/, '')}` }
    })
  }

  /** HTML → Base64，可直接用于回复消息的 `image.base64` */
  async renderBase64(html: string, options: T2IRenderOptions = {}): Promise<T2IRenderBase64Result> {
    const { data, byteSize } = await this.render(html, options)
    return { base64: arrayBufferToBase64(data), byteSize }
  }

  /** 连通性测试：渲染一张 64x64 极小图并测耗时 */
  async ping(options: T2IOptions = {}): Promise<T2IPingResult> {
    const startedAt = Date.now()
    try {
      await this.render('<html><body style="margin:0;background:#fff"></body></html>', {
        width: 64,
        height: 64,
        fullPage: false,
        type: 'png',
        timeoutMs: options.timeoutMs ?? Math.min(this.defaultTimeoutMs, 20000),
      })
      return { ok: true, latencyMs: Date.now() - startedAt }
    } catch (err: unknown) {
      return { ok: false, latencyMs: 0, error: err instanceof Error ? err.message : String(err) }
    }
  }
}
