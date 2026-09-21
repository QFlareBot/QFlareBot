/**
 * QQ Webhook 签名：以 AppSecret 重复拼接至 32 字节作为 Ed25519 种子。
 * 回调验证（op 13）用私钥签 `event_ts + plain_token`；事件推送用公钥验 `timestamp + body`。
 */

const PKCS8_ED25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
])

const encoder = new TextEncoder()
const keyCache = new Map<string, Promise<CryptoKeyPair>>()

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hex 长度必须为偶数')
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

export function bytesToHex(buffer: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function seedFromSecret(secret: string): Uint8Array {
  // 空 secret 会让下面的 while 永远拼不满 32 字节——直接把 isolate 挂死。
  // 宁可当场抛错：拿不到 AppSecret 本来也派不出有意义的密钥，挂死只会让请求超时得不明不白。
  if (!secret) throw new Error('AppSecret 为空，无法派生签名密钥')
  let seed = secret
  while (encoder.encode(seed).length < 32) seed += secret
  return encoder.encode(seed).slice(0, 32)
}

async function deriveKeyPair(secret: string): Promise<CryptoKeyPair> {
  const seed = seedFromSecret(secret)
  const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + seed.length)
  pkcs8.set(PKCS8_ED25519_PREFIX)
  pkcs8.set(seed, PKCS8_ED25519_PREFIX.length)

  const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign'])
  const jwk = (await crypto.subtle.exportKey('jwk', privateKey)) as JsonWebKey
  if (!jwk.x) throw new Error('Ed25519 公钥导出失败')
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    { kty: 'OKP', crv: 'Ed25519', x: jwk.x },
    { name: 'Ed25519' },
    false,
    ['verify'],
  )
  return { privateKey, publicKey }
}

/** 同一 secret 的密钥对只派生一次 */
export function getKeyPair(secret: string): Promise<CryptoKeyPair> {
  let pair = keyCache.get(secret)
  if (!pair) {
    // 失败的派生不留缓存：否则一次瞬时错误会被永久记住，之后连重试的机会都没有
    pair = deriveKeyPair(secret).catch((err: unknown) => {
      keyCache.delete(secret)
      throw err
    })
    keyCache.set(secret, pair)
  }
  return pair
}

/** 回调地址验证：返回 hex 签名 */
export async function signCallback(secret: string, eventTs: string, plainToken: string): Promise<string> {
  const { privateKey } = await getKeyPair(secret)
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, encoder.encode(eventTs + plainToken))
  return bytesToHex(sig)
}

/** 事件推送验签：签名覆盖 `X-Signature-Timestamp + 原始 body` */
export async function verifyEvent(
  secret: string,
  timestamp: string,
  rawBody: string,
  signatureHex: string,
): Promise<boolean> {
  if (!signatureHex || !timestamp) return false
  try {
    const { publicKey } = await getKeyPair(secret)
    const message = encoder.encode(timestamp + rawBody)
    return await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, hexToBytes(signatureHex), message)
  } catch {
    return false
  }
}
