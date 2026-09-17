/** 运行时单测用的最小绑定实现 */
import { bytesToHex, getKeyPair } from '@qqbot/api'
import type { RuntimeEnv } from '../types.js'

export function createKV(): KVNamespace & { readonly store: Map<string, string> } {
  const store = new Map<string, string>()
  const kv = {
    store,
    async get(key: string, type?: string) {
      const v = store.get(key)
      if (v === undefined) return null
      return type === 'json' ? JSON.parse(v) : v
    },
    async put(key: string, value: string) {
      store.set(key, value)
    },
    async delete(key: string) {
      store.delete(key)
    },
    async list(options: { prefix?: string } = {}) {
      const prefix = options.prefix ?? ''
      return {
        keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
        cacheStatus: null,
      }
    },
  }
  return kv as unknown as KVNamespace & { readonly store: Map<string, string> }
}

export function createD1(): D1Database {
  const unsupported = () => {
    throw new Error('测试环境未提供 D1')
  }
  return { prepare: unsupported, exec: unsupported, batch: unsupported, dump: unsupported } as unknown as D1Database
}

export function createExecutionContext(): ExecutionContext & { flush(): Promise<void> } {
  const pending: Promise<unknown>[] = []
  return {
    waitUntil: (p) => void pending.push(p),
    passThroughOnException() {},
    props: {},
    async flush() {
      await Promise.all(pending.splice(0))
    },
  } as unknown as ExecutionContext & { flush(): Promise<void> }
}

export const TEST_SECRET = 'DG5g3B4j9X2KOErG'
export const TEST_APPID = '1903864677'

export function createEnv(overrides: Partial<RuntimeEnv> = {}): RuntimeEnv & { KV: ReturnType<typeof createKV> } {
  return {
    KV: createKV(),
    DB: createD1(),
    BOT_APPID: TEST_APPID,
    BOT_SECRET: TEST_SECRET,
    ADMIN_TOKEN: 'admin-token',
    ...overrides,
  }
}

/** 按 QQ 规则给事件请求签名（timestamp + body） */
export async function signedRequest(url: string, body: unknown, secret = TEST_SECRET, tsOverride?: number): Promise<Request> {
  const rawBody = JSON.stringify(body)
  const ts = String(tsOverride ?? Math.floor(Date.now() / 1000))
  const { privateKey } = await getKeyPair(secret)
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, new TextEncoder().encode(ts + rawBody))
  return new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-signature-ed25519': bytesToHex(sig),
      'x-signature-timestamp': ts,
    },
    body: rawBody,
  })
}

/** 模拟 QQ OpenAPI：记录发出的消息 */
export function createQQFetch() {
  const sent: Array<{ url: string; body: Record<string, unknown> }> = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    if (url.includes('getAppAccessToken')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 7200 }), { status: 200 })
    }
    sent.push({ url, body: JSON.parse(String(init?.body ?? '{}')) })
    return new Response(JSON.stringify({ id: `sent-${sent.length}` }), { status: 200 })
  }
  return { fetchImpl, sent }
}

export function groupMessagePayload(content: string, id = `evt-${Math.random().toString(36).slice(2)}`) {
  return {
    op: 0,
    id: `GROUP_AT_MESSAGE_CREATE:${id}`,
    t: 'GROUP_AT_MESSAGE_CREATE',
    d: {
      id: `ROBOT1.0_${id}`,
      content: ` ${content}`,
      timestamp: new Date().toISOString(),
      author: { id: 'U1', member_openid: 'U1', username: '测试' },
      group_openid: 'G1',
    },
  }
}
