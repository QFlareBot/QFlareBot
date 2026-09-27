/**
 * 面板端：把一个 iframe 接到桥上。与 UI 框架无关，面板里用组合式函数包一层即可。
 *
 * 令牌交给谁：sandbox iframe 里所有文档的 origin 都是 'null'，面板分不清「同插件的下一页」和
 * 「插件页链接过去的外站」，只能按 iframe 的 load 事件把时间切成一段一段来收紧（见 attachBridgeHost）。
 * 残余风险写在 docs/ui.md：插件页的外链要开新窗口。
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

/** 应答过 ready 的那个文档 */
interface Handshake {
  /**
   * 它自己的 load 还没到。页面脚本（模块脚本）通常在文档 load 之前就发 ready，
   * 所以握手之后到来的第一个 load 多半是它自己的，不能当成「换了文档」。
   */
  ownLoadPending: boolean
  /** 之后又来了不属于它的 load：iframe 里已经换成别的文档，令牌不再推给它 */
  stale: boolean
}

/**
 * 把 iframe 接上桥。消息格式与以前完全一样，旧版页面端（插件自己打包的 @qqbot/ui-bridge）照常握手。
 *
 * 按 iframe 的 load 事件分段收紧：
 * - 两次 load 之间只应答一次 ready：同一次加载里重复的 ready 不再发 init、不再签新令牌；
 *   页面跳到下一页（或外站）会有新的 load，那之后的 ready 照常应答——多页面的插件页靠它拿令牌。
 * - 定时刷新只推给当前握手的文档：iframe 换了文档、新文档还没握手之前，一枚令牌都不推。
 * 握手之后的第一个 load 算它自己的（ownLoadPending），见 Handshake。
 */
export function attachBridgeHost(options: HostOptions): BridgeHost {
  const nonce = crypto.randomUUID()
  let theme = options.theme
  let destroyed = false
  let handshake: Handshake | null = null
  /** 上次应答 ready 之后来过 load：新的一段，可以再应答一次 */
  let answeredThisLoad = false
  /** 来过一个没被任何握手认领的 load：之后握手的文档已经加载完，不会再有它自己的 load */
  let unclaimedLoad = false
  /** 正在为某次 ready 取令牌 */
  let initInFlight = false

  const send = (msg: HostMessage) => {
    options.iframe.contentWindow?.postMessage(msg, '*')
  }

  const onLoad = () => {
    answeredThisLoad = false
    if (handshake && !handshake.stale && handshake.ownLoadPending) {
      handshake.ownLoadPending = false
      return
    }
    if (handshake) handshake.stale = true
    unclaimedLoad = true
  }

  const answerReady = async () => {
    // 同一段里只应答一次；标记要在 await 之前打上，取令牌期间再来的 ready 也算重复
    if (answeredThisLoad || initInFlight) return
    answeredThisLoad = true
    initInFlight = true
    const hs: Handshake = { ownLoadPending: !unclaimedLoad, stale: false }
    unclaimedLoad = false
    handshake = hs
    let token: string
    try {
      token = await options.getToken()
    } catch {
      // 没签出令牌：不算握手成功（定时刷新不能推给一个没拿到 init 的文档），页面再发 ready 可以重试。
      // 它自己的 load 已经来过（或握手时就已加载完）的话记下来，重试时别再等一个不会来的 load
      if (handshake === hs) {
        handshake = null
        answeredThisLoad = false
        if (!hs.ownLoadPending) unclaimedLoad = true
      }
      return
    } finally {
      initInFlight = false
    }
    // 取令牌期间 iframe 换了文档：发 ready 的那个已经不在了，令牌不交给接替它的文档
    if (destroyed || handshake !== hs || hs.stale) return
    send({ channel: CHANNEL, type: 'init', nonce, token, theme, plugin: options.plugin, base: options.base })
  }

  const onMessage = (ev: MessageEvent) => {
    if (destroyed || ev.source !== options.iframe.contentWindow) return
    const data: unknown = ev.data
    if (!isBridgeMessage(data)) return
    const msg = data as GuestMessage
    if (msg.type === 'ready') {
      void answerReady()
      return
    }
    if (msg.nonce !== nonce) return
    if (msg.type === 'resize') options.onResize?.(msg.height)
    if (msg.type === 'toast') options.onToast?.(msg.level, msg.message)
    if (msg.type === 'navigate') options.onNavigate?.(msg.to)
    if (msg.type === 'title') options.onTitle?.(msg.title)
  }
  window.addEventListener('message', onMessage)
  options.iframe.addEventListener('load', onLoad)

  const timer = setInterval(async () => {
    const hs = handshake
    if (destroyed || !hs || hs.stale) return
    let token: string
    try {
      token = await options.getToken()
    } catch {
      return // 这次没取到，下一轮再试；旧令牌还有 15 分钟
    }
    if (destroyed || handshake !== hs || hs.stale) return
    send({ channel: CHANNEL, type: 'token', nonce, token })
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
      options.iframe.removeEventListener('load', onLoad)
    },
  }
}
