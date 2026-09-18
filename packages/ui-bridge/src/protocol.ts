/**
 * 面板（host）与插件页面（guest，iframe 内）之间的 postMessage 协议。
 * iframe 以 sandbox 运行在 opaque origin，所以 origin 校验用 `'*'`，
 * 靠 `channel` 前缀与 nonce 过滤无关消息；权限边界由桥接 token 决定，不靠 origin。
 */

export const CHANNEL = 'qqbot-bridge/1'

export type Theme = 'light' | 'dark'

/** host → guest */
export type HostMessage =
  | { channel: typeof CHANNEL; type: 'init'; nonce: string; token: string; theme: Theme; plugin: string; base: string }
  | { channel: typeof CHANNEL; type: 'theme'; nonce: string; theme: Theme }
  | { channel: typeof CHANNEL; type: 'token'; nonce: string; token: string }

/** guest → host */
export type GuestMessage =
  | { channel: typeof CHANNEL; type: 'ready' }
  | { channel: typeof CHANNEL; type: 'resize'; nonce: string; height: number }
  | { channel: typeof CHANNEL; type: 'toast'; nonce: string; level: 'info' | 'success' | 'warning' | 'error'; message: string }
  | { channel: typeof CHANNEL; type: 'navigate'; nonce: string; to: string }
  | { channel: typeof CHANNEL; type: 'title'; nonce: string; title: string }

export function isBridgeMessage(data: unknown): data is HostMessage | GuestMessage {
  return typeof data === 'object' && data !== null && (data as { channel?: unknown }).channel === CHANNEL
}
