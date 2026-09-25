/**
 * 扫码创建机器人（q.qq.com 的 lite 绑定接口，协议照抄 AstrBot qqofficial/login_registration.py）。
 *
 * 1. 本地生成 AES-256 密钥，`create_bind_task { key }` 换 task_id
 * 2. 把 connect.html?task_id=… 做成二维码，手机 QQ 扫码确认即新建一个机器人
 * 3. 轮询 `poll_bind_result { task_id }`：status 1 等待 / 2 完成 / 3 过期（实测约 3 分钟过期）
 * 4. 完成时返回 bot_appid 与 bot_encrypt_secret = base64(12 字节 nonce ‖ 密文 ‖ 16 字节 GCM tag)，用第 1 步的密钥解出 AppSecret
 *
 * 接口不带 CORS 头，只能从服务端调用。
 */

export const DEFAULT_BIND_HOST = 'https://q.qq.com'

export interface BindTask {
  taskId: string
  /** base64 的 AES-256 密钥；轮询时要带回来解密 */
  key: string
  /** 二维码内容：手机 QQ 扫码打开 */
  qrUrl: string
}

export type BindResult =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'created'; appId: string; secret: string; userOpenid: string }

export interface BindOptions {
  fetchImpl?: typeof fetch
  host?: string
}

const BIND_STATUS_COMPLETED = 2
const BIND_STATUS_EXPIRED = 3

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function fromBase64(value: string): Uint8Array {
  const s = atob(value)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

async function post(path: string, payload: unknown, options: BindOptions): Promise<Record<string, unknown>> {
  const fetchImpl = options.fetchImpl ?? fetch
  const res = await fetchImpl(`${options.host ?? DEFAULT_BIND_HOST}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`QQ 机器人绑定接口 HTTP ${res.status}`)
  const data = (await res.json().catch(() => null)) as { retcode?: unknown; msg?: unknown; data?: unknown } | null
  if (!data || typeof data !== 'object') throw new Error('QQ 机器人绑定接口响应格式异常')
  if (data.retcode !== undefined && Number(data.retcode) !== 0) {
    throw new Error(typeof data.msg === 'string' && data.msg ? data.msg : 'QQ 机器人绑定接口返回失败')
  }
  return data.data && typeof data.data === 'object' ? (data.data as Record<string, unknown>) : {}
}

export async function createBindTask(options: BindOptions = {}): Promise<BindTask> {
  const key = toBase64(crypto.getRandomValues(new Uint8Array(32)))
  const data = await post('/lite/create_bind_task', { key }, options)
  const taskId = typeof data.task_id === 'string' ? data.task_id.trim() : ''
  if (!taskId) throw new Error('QQ 机器人绑定任务响应缺少 task_id')
  const qrUrl = `${options.host ?? DEFAULT_BIND_HOST}/qqbot/openclaw/connect.html?task_id=${encodeURIComponent(taskId)}&_wv=2`
  return { taskId, key, qrUrl }
}

export async function decryptBindSecret(encrypted: string, key: string): Promise<string> {
  let raw: Uint8Array
  let keyBytes: Uint8Array
  try {
    raw = fromBase64(encrypted)
    keyBytes = fromBase64(key)
  } catch {
    throw new Error('QQ 机器人凭证解码失败')
  }
  if (keyBytes.length !== 32 || raw.length <= 28) throw new Error('QQ 机器人凭证密文格式异常')
  try {
    const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt'])
    // WebCrypto 的 AES-GCM 输入就是 密文‖tag
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, cryptoKey, raw.slice(12))
    return new TextDecoder().decode(plain)
  } catch {
    throw new Error('QQ 机器人凭证解密失败')
  }
}

export async function pollBindResult(taskId: string, key: string, options: BindOptions = {}): Promise<BindResult> {
  const data = await post('/lite/poll_bind_result', { task_id: taskId }, options)
  const status = Number(data.status ?? 0)
  if (status === BIND_STATUS_EXPIRED) return { status: 'expired' }
  if (status !== BIND_STATUS_COMPLETED) return { status: 'pending' }
  const appId = String(data.bot_appid ?? '').trim()
  const encrypted = String(data.bot_encrypt_secret ?? '').trim()
  if (!appId || appId === '0' || !encrypted) throw new Error('扫码成功但未返回完整 QQ 机器人凭证')
  return {
    status: 'created',
    appId,
    secret: await decryptBindSecret(encrypted, key),
    userOpenid: String(data.user_openid ?? '').trim(),
  }
}
