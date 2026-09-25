import { describe, expect, it, vi } from 'vitest'
import { createBindTask, decryptBindSecret, pollBindResult } from './bind.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** 按 q.qq.com 的格式加密：base64(nonce ‖ 密文 ‖ tag) */
async function encrypt(secret: string, key: string): Promise<string> {
  const keyBytes = Uint8Array.from(atob(key), (c) => c.charCodeAt(0))
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, new TextEncoder().encode(secret)))
  return btoa(String.fromCharCode(...iv, ...sealed))
}

describe('扫码创建机器人', () => {
  it('建任务：发送 32 字节密钥，返回 connect 页地址', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ retcode: 0, msg: 'success', data: { task_id: 't/1' } }))
    const task = await createBindTask({ fetchImpl })
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://q.qq.com/lite/create_bind_task')
    expect(JSON.parse(init!.body as string).key).toBe(task.key)
    expect(atob(task.key)).toHaveLength(32)
    expect(task.qrUrl).toBe('https://q.qq.com/qqbot/openclaw/connect.html?task_id=t%2F1&_wv=2')
  })

  it('retcode 非 0 抛出平台消息', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ retcode: 10001, msg: '频率过快' }))
    await expect(createBindTask({ fetchImpl })).rejects.toThrow('频率过快')
  })

  it('轮询：等待 / 过期 / 完成并解密', async () => {
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    const encrypted = await encrypt('gCabcdefRJ', key)
    const replies = [
      { status: 1, bot_appid: '0', bot_encrypt_secret: '', user_openid: '' },
      { status: 3 },
      { status: 2, bot_appid: '1905677019', bot_encrypt_secret: encrypted, user_openid: '4EAF10C04D3E' },
    ]
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ retcode: 0, data: replies.shift() }))
    expect(await pollBindResult('t1', key, { fetchImpl })).toEqual({ status: 'pending' })
    expect(await pollBindResult('t1', key, { fetchImpl })).toEqual({ status: 'expired' })
    expect(await pollBindResult('t1', key, { fetchImpl })).toEqual({
      status: 'created',
      appId: '1905677019',
      secret: 'gCabcdefRJ',
      userOpenid: '4EAF10C04D3E',
    })
    expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string)).toEqual({ task_id: 't1' })
  })

  it('密钥不对时解密失败', async () => {
    const key = btoa('k'.repeat(32))
    const encrypted = await encrypt('secret', key)
    await expect(decryptBindSecret(encrypted, btoa('x'.repeat(32)))).rejects.toThrow('解密失败')
    await expect(decryptBindSecret(btoa('short'), key)).rejects.toThrow('格式异常')
  })
})
