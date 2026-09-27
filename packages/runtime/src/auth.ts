/**
 * 无状态令牌：以 ADMIN_TOKEN 为 HMAC 密钥签发，轮换 ADMIN_TOKEN 即让全部令牌失效。
 * - 会话令牌：面板登录后持有，浏览器里不再保存管理密钥
 * - 桥接令牌：限定单个插件，面板交给 iframe 里的插件页面使用
 */

export type TokenClaims =
  | { kind: 'session'; exp: number }
  | { kind: 'bridge'; plugin: string; exp: number }

const encoder = new TextEncoder()
const keyCache = new Map<string, Promise<CryptoKey>>()

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret)
  if (!key) {
    key = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
    keyCache.set(secret, key)
  }
  return key
}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
}

export async function signToken(claims: TokenClaims, secret: string): Promise<string> {
  const payload = b64url(encoder.encode(JSON.stringify(claims)))
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(payload))
  return `${payload}.${b64url(sig)}`
}

export async function verifyToken(token: string, secret: string): Promise<TokenClaims | null> {
  const dot = token.indexOf('.')
  if (dot <= 0) return null
  const payload = token.slice(0, dot)
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64url(token.slice(dot + 1)), encoder.encode(payload))
    if (!ok) return null
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as TokenClaims
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return null
    return claims
  } catch {
    return null
  }
}

export interface AuthResult {
  /** 管理密钥本身或有效会话令牌 */
  admin: boolean
  /** 桥接令牌所属插件 */
  bridgePlugin: string | undefined
}

const NONE: AuthResult = { admin: false, bridgePlugin: undefined }

export function bearerOf(request: Request): string {
  const header = request.headers.get('authorization') ?? ''
  return header.startsWith('Bearer ') ? header.slice(7).trim() : ''
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))
}

/**
 * 恒定时间比较两个密钥（管理密钥、BUILD_TOKEN）。
 *
 * `===` 在第一个不同的字符处就返回，响应时间随「猜对了几位」变化，理论上能一位一位试出来。
 * 两边先 SHA-256 成等长的 32 字节再逐字节异或累加：比较耗时与内容无关，长度也不会从提前返回里漏出去。
 * 不用 workerd 的 `crypto.subtle.timingSafeEqual`——Node 里没有，单测跑不了。
 */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)])
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!
  return diff === 0
}

export interface AuthenticateOptions {
  /**
   * 是否也接受地址里的 `?token=`，默认接受。只有 `/p/<插件>/` 的插件页需要它：iframe 与新窗口的首个请求
   * 带不了 Authorization 头。管理 API 从来都走请求头，关掉它，令牌就不会跟着地址进访问日志与浏览器历史。
   */
  queryToken?: boolean
}

/** 解析请求的登录态；`adminToken` 未配置时一律未授权 */
export async function authenticate(
  request: Request,
  adminToken: string | undefined,
  options: AuthenticateOptions = {},
): Promise<AuthResult> {
  if (!adminToken) return NONE
  const fromQuery = options.queryToken === false ? '' : new URL(request.url).searchParams.get('token')
  const bearer = bearerOf(request) || fromQuery || ''
  if (!bearer) return NONE
  if (await constantTimeEqual(bearer, adminToken)) return { admin: true, bridgePlugin: undefined }
  const claims = await verifyToken(bearer, adminToken)
  if (!claims) return NONE
  if (claims.kind === 'session') return { admin: true, bridgePlugin: undefined }
  return { admin: false, bridgePlugin: claims.plugin }
}

export const SESSION_TTL_SEC = 7 * 24 * 3600
export const BRIDGE_TTL_SEC = 3600

export function issueSession(secret: string): Promise<string> {
  return signToken({ kind: 'session', exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC }, secret)
}

export function issueBridge(secret: string, plugin: string): Promise<string> {
  return signToken({ kind: 'bridge', plugin, exp: Math.floor(Date.now() / 1000) + BRIDGE_TTL_SEC }, secret)
}
