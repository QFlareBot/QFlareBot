/**
 * 面板端：把一个 iframe 接到桥上。与 UI 框架无关，面板里用组合式函数包一层即可。
 */
import { CHANNEL, isBridgeMessage, type GuestMessage, type HostMessage, type Theme } from './protocol.js'

export interface HostOptions {
  iframe: HTMLIFrameElement
  plugin: string
  /** 插件路由根，如 `/p/foo` */
  base: string
  theme: Theme
  /** 首次与每次刷新时取桥接 token */
  getToken: () => Promise<string>
  onResize?: (height: number) => void
  onToast?: (level: 'info' | 'success' | 'warning' | 'error', message: string) => void
  onNavigate?: (to: string) => void
  onTitle?: (title: string) => void
  /** token 刷新间隔（毫秒），默认 45 分钟（令牌有效期 1 小时） */
  refreshMs?: number
}

export interface BridgeHost {
  setTheme(theme: Theme): void
  destroy(): void
}

export function attachBridgeHost(options: HostOptions): BridgeHost {
  const nonce = crypto.randomUUID()
  let theme = options.theme
  let destroyed = false

  const send = (msg: HostMessage) => {
    options.iframe.contentWindow?.postMessage(msg, '*')
  }

  const onMessage = async (ev: MessageEvent) => {
    if (destroyed || ev.source !== options.iframe.contentWindow) return
    const data: unknown = ev.data
    if (!isBridgeMessage(data)) return
    const msg = data as GuestMessage
    if (msg.type === 'ready') {
      send({ channel: CHANNEL, type: 'init', nonce, token: await options.getToken(), theme, plugin: options.plugin, base: options.base })
      return
    }
    if (msg.nonce !== nonce) return
    if (msg.type === 'resize') options.onResize?.(msg.height)
    if (msg.type === 'toast') options.onToast?.(msg.level, msg.message)
    if (msg.type === 'navigate') options.onNavigate?.(msg.to)
    if (msg.type === 'title') options.onTitle?.(msg.title)
  }
  window.addEventListener('message', onMessage)

  const timer = setInterval(async () => {
    if (destroyed) return
    send({ channel: CHANNEL, type: 'token', nonce, token: await options.getToken() })
  }, options.refreshMs ?? 45 * 60 * 1000)

  return {
    setTheme(t) {
      theme = t
      send({ channel: CHANNEL, type: 'theme', nonce, theme: t })
    },
    destroy() {
      destroyed = true
      clearInterval(timer)
      window.removeEventListener('message', onMessage)
    },
  }
}
