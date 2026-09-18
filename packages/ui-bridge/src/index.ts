/**
 * 插件页面端客户端：在 iframe 里调用 `createBridge()`，
 * 等待面板下发桥接 token 与主题，之后用 `bridge.fetch` 访问自己的 `auth: 'admin'` 路由。
 * 不在 iframe 中（直接打开页面调试）时降级：token 取 URL 的 ?token=，主题跟随系统。
 */
import { CHANNEL, isBridgeMessage, type GuestMessage, type HostMessage, type Theme } from './protocol.js'

export type { Theme, HostMessage, GuestMessage } from './protocol.js'
export { CHANNEL } from './protocol.js'

export interface Bridge {
  /** 面板是否存在（在 iframe 内且已握手） */
  readonly embedded: boolean
  readonly plugin: string
  /** 插件路由根，如 `/p/foo` */
  readonly base: string
  readonly theme: Theme
  /** 自动带上桥接 token；相对路径以插件路由根解析 */
  fetch(input: string, init?: RequestInit): Promise<Response>
  onTheme(handler: (theme: Theme) => void): () => void
  toast(message: string, level?: 'info' | 'success' | 'warning' | 'error'): void
  /** 让面板跳转到某个路由，如 `/plugins` */
  navigate(to: string): void
  setTitle(title: string): void
  /** 上报内容高度；不传则自动测量并持续跟随 */
  resize(height?: number): void
}

export interface BridgeOptions {
  /** 握手超时（毫秒），超时后按非嵌入模式工作，默认 1500 */
  timeout?: number
  /** 是否自动把主题写到 <html data-theme>，默认 true */
  applyTheme?: boolean
}

function systemTheme(): Theme {
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function guessBase(): string {
  const m = location.pathname.match(/^\/p\/[^/]+/)
  return m ? m[0] : ''
}

export function createBridge(options: BridgeOptions = {}): Promise<Bridge> {
  const applyTheme = options.applyTheme ?? true
  const inFrame = window.parent !== window
  let nonce = ''
  let token = new URLSearchParams(location.search).get('token') ?? ''
  let theme: Theme = systemTheme()
  let plugin = guessBase().replace('/p/', '')
  let base = guessBase()
  const themeHandlers = new Set<(t: Theme) => void>()

  const setTheme = (t: Theme) => {
    theme = t
    if (applyTheme) document.documentElement.dataset.theme = t
    for (const h of themeHandlers) h(t)
  }

  const post = (msg: GuestMessage) => {
    if (inFrame) window.parent.postMessage(msg, '*')
  }

  let observer: ResizeObserver | null = null
  const measure = () => post({ channel: CHANNEL, type: 'resize', nonce, height: document.documentElement.scrollHeight })

  const bridge: Bridge = {
    get embedded() {
      return inFrame && nonce !== ''
    },
    get plugin() {
      return plugin
    },
    get base() {
      return base
    },
    get theme() {
      return theme
    },
    fetch(input, init = {}) {
      const url = input.startsWith('/') && !input.startsWith(base) && base ? base + input : input
      const headers = new Headers(init.headers)
      if (token) headers.set('authorization', `Bearer ${token}`)
      return fetch(url, { ...init, headers })
    },
    onTheme(handler) {
      themeHandlers.add(handler)
      return () => themeHandlers.delete(handler)
    },
    toast(message, level = 'info') {
      post({ channel: CHANNEL, type: 'toast', nonce, level, message })
    },
    navigate(to) {
      post({ channel: CHANNEL, type: 'navigate', nonce, to })
    },
    setTitle(title) {
      document.title = title
      post({ channel: CHANNEL, type: 'title', nonce, title })
    },
    resize(height) {
      if (height !== undefined) {
        post({ channel: CHANNEL, type: 'resize', nonce, height })
        return
      }
      if (!observer) {
        observer = new ResizeObserver(measure)
        observer.observe(document.documentElement)
      }
      measure()
    },
  }

  if (applyTheme) document.documentElement.dataset.theme = theme

  return new Promise((resolve) => {
    if (!inFrame) {
      resolve(bridge)
      return
    }
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      resolve(bridge)
    }
    window.addEventListener('message', (ev: MessageEvent) => {
      const data: unknown = ev.data
      if (!isBridgeMessage(data)) return
      const msg = data as HostMessage
      if (msg.type === 'init') {
        nonce = msg.nonce
        token = msg.token
        plugin = msg.plugin
        base = msg.base
        setTheme(msg.theme)
        done()
        return
      }
      if (!nonce || msg.nonce !== nonce) return
      if (msg.type === 'theme') setTheme(msg.theme)
      if (msg.type === 'token') token = msg.token
    })
    post({ channel: CHANNEL, type: 'ready' })
    setTimeout(done, options.timeout ?? 1500)
  })
}
