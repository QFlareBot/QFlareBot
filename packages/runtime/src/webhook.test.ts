/**
 * Webhook 入口的两条安全 / 可观测约束：
 *  - op 13 回调验证不能沦为签名机：它签 `event_ts + plain_token`，事件验签用同一把钥匙验 `时间戳 + body`，
 *    签名不符时还照签任意内容，伪造事件就能拿到有效签名
 *  - 事件处理在 waitUntil 里被平台 30 秒掐断时，至少要留下一行告警
 */
import { definePlugin } from '@qqbot/sdk'
import { getKeyPair, hexToBytes } from '@qqbot/api'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRuntime } from './runtime.js'
import { resetLifecycle } from './lifecycle.js'
import { resetSnapshotCache } from './store.js'
import {
  createEnv,
  createExecutionContext,
  createQQFetch,
  groupMessagePayload,
  signedRequest,
  TEST_SECRET,
} from './testing/mocks.js'

const BASE = 'https://bot.test'

beforeEach(() => {
  resetSnapshotCache()
  resetLifecycle()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** 用 secret 签一个 op 13 请求；secret 不对就是签名不符的请求 */
async function callbackVerify(d: Record<string, unknown>, secret = TEST_SECRET) {
  const runtime = createRuntime({ plugins: [] })
  return runtime.fetch!(await signedRequest(`${BASE}/webhook`, { op: 13, d }, secret), createEnv(), createExecutionContext())
}

async function signatureCovers(signature: string, message: string): Promise<boolean> {
  const { publicKey } = await getKeyPair(TEST_SECRET)
  return crypto.subtle.verify({ name: 'Ed25519' }, publicKey, hexToBytes(signature), new TextEncoder().encode(message))
}

describe('op 13 回调验证', () => {
  /** 攻击者想要签名的请求体：一个能被分发的群消息事件 */
  const forged = JSON.stringify(groupMessagePayload('/echo 伪造', 'forged'))

  it('签名不符、plain_token 是 JSON：拒绝，不替它签名', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ts = String(Math.floor(Date.now() / 1000))
    // 签下来就是 `ts + forged`，正好是一次合法事件推送要验的内容
    const res = await callbackVerify({ plain_token: forged, event_ts: ts }, 'wrong-secret')
    expect(res.status).toBe(401)
    expect(await res.json()).not.toHaveProperty('signature')
  })

  it('签名不符、格式不对（event_ts 非纯数字或过长，plain_token 带空白或过长）：同样拒绝', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const d of [
      { plain_token: 'abc', event_ts: '1725442341{' },
      { plain_token: 'abc', event_ts: '1'.repeat(21) },
      { plain_token: 'has space', event_ts: '1725442341' },
      { plain_token: 'x'.repeat(257), event_ts: '1725442341' },
    ]) {
      expect((await callbackVerify(d, 'wrong-secret')).status).toBe(401)
    }
  })

  it('签名不符、plain_token 是普通字母数字（含 base64 字符）：照旧签名，保证平台配置总能完成', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const token of ['Arq0D5A61EgUu4OxUvOp', 'a+b/c=d_e-f.g']) {
      const res = await callbackVerify({ plain_token: token, event_ts: '1725442341' }, 'wrong-secret')
      expect(res.status).toBe(200)
      const data = (await res.json()) as { plain_token: string; signature: string }
      expect(data.plain_token).toBe(token)
      expect(await signatureCovers(data.signature, `1725442341${token}`)).toBe(true)
    }
  })

  it('签名有效：任意 plain_token 都照签（请求确实来自持有密钥的平台）', async () => {
    const res = await callbackVerify({ plain_token: forged, event_ts: '1725442341' })
    expect(res.status).toBe(200)
    const data = (await res.json()) as { signature: string }
    expect(await signatureCovers(data.signature, `1725442341${forged}`)).toBe(true)
  })
})

describe('事件处理 30 秒上限', () => {
  function warnings(spy: ReturnType<typeof vi.spyOn>) {
    return spy.mock.calls.map(([line]) => JSON.parse(String(line)) as { message: string; data?: unknown })
  }

  it('分发超过 25 秒时告警（带 id、event），跑完后定时器被清掉', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const slow = definePlugin({
      name: 'slow',
      version: '1.0.0',
      commands: {
        slow: async () => {
          await gate
          return '终于好了'
        },
      },
    })
    const runtime = createRuntime({ plugins: [slow], fetchImpl: createQQFetch().fetchImpl })
    const execCtx = createExecutionContext()
    const payload = groupMessagePayload('/slow', 'slow-1')

    const res = await runtime.fetch!(await signedRequest(`${BASE}/webhook`, payload), createEnv(), execCtx)
    expect(res.status).toBe(200)
    await vi.advanceTimersByTimeAsync(24_999)
    expect(warnings(warn)).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(warnings(warn)).toEqual([
      { level: 'warn', scope: 'runtime', message: expect.stringContaining('25 秒'), data: { id: payload.id, event: 'qq.group.at_message' } },
    ])

    release()
    await execCtx.flush()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('正常分发完不留定时器，也不告警', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const quick = definePlugin({ name: 'quick', version: '1.0.0', commands: { hi: () => '你好' } })
    const qq = createQQFetch()
    const runtime = createRuntime({ plugins: [quick], fetchImpl: qq.fetchImpl })
    const execCtx = createExecutionContext()

    await runtime.fetch!(await signedRequest(`${BASE}/webhook`, groupMessagePayload('/hi')), createEnv(), execCtx)
    await execCtx.flush()
    expect(qq.sent).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(warnings(warn)).toEqual([])
  })
})
