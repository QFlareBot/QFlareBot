import { definePlugin } from '@qqbot/sdk'
import { beforeEach, describe, expect, it } from 'vitest'
import { isSecretPlaceholder, maskSecrets, restoreSecrets } from './configSecrets.js'
import { resetLifecycle } from './lifecycle.js'
import { createRuntime } from './runtime.js'
import { resetSnapshotCache } from './store.js'
import { createEnv, createExecutionContext } from './testing/mocks.js'

const schema = {
  type: 'object',
  properties: {
    api_key: { type: 'string', writeOnly: true },
    model: { type: 'string' },
    providers: {
      type: 'array',
      items: { type: 'object', properties: { name: { type: 'string' }, key: { type: 'string', writeOnly: true } } },
    },
    tokens: { type: 'object', additionalProperties: { type: 'string', writeOnly: true } },
  },
}

const config = {
  api_key: 'sk-root',
  model: 'm',
  providers: [
    { name: 'a', key: 'ka' },
    { name: 'b', key: 'kb' },
  ],
  tokens: { x: 'tx' },
}

describe('maskSecrets', () => {
  it('writeOnly 的值换成占位符，其余原样；不改入参', () => {
    const masked = maskSecrets(schema, config) as typeof config
    expect(masked.model).toBe('m')
    expect(masked.providers.map((p) => p.name)).toEqual(['a', 'b'])
    for (const v of [masked.api_key, masked.providers[0]!.key, masked.providers[1]!.key, masked.tokens['x']]) {
      expect(isSecretPlaceholder(v)).toBe(true)
    }
    expect(JSON.stringify(masked)).not.toMatch(/sk-root|ka|kb|tx/)
    expect(config.api_key).toBe('sk-root')
  })

  it('没设置的（空串、没有）不换：面板据此显示「未设置」', () => {
    expect(maskSecrets(schema, { api_key: '' })).toEqual({ api_key: '' })
    expect(maskSecrets(schema, { model: 'm' })).toEqual({ model: 'm' })
  })

  it('没有 schema 原样返回', () => {
    expect(maskSecrets(undefined, config)).toBe(config)
  })
})

describe('restoreSecrets', () => {
  const masked = maskSecrets(schema, config) as typeof config

  it('原样交回：全部换回真值', () => {
    expect(restoreSecrets(schema, masked, config)).toEqual(config)
  })

  it('数组换了顺序、删了一项也对得上：占位符记的是下发时的位置，不按下标对齐', () => {
    const reordered = { ...masked, providers: [masked.providers[1]!, { name: 'c', key: 'kc' }] }
    expect((restoreSecrets(schema, reordered, config) as typeof config).providers).toEqual([
      { name: 'b', key: 'kb' },
      { name: 'c', key: 'kc' },
    ])
  })

  it('新填的值、清空（空串）原样保留', () => {
    expect(restoreSecrets(schema, { ...masked, api_key: 'sk-new' }, config)).toMatchObject({ api_key: 'sk-new' })
    expect(restoreSecrets(schema, { ...masked, api_key: '' }, config)).toMatchObject({ api_key: '' })
  })

  it('占位符对不上值（期间配置被改过）就置空，不把占位符当密钥存进去', () => {
    const restored = restoreSecrets(schema, masked, { ...config, api_key: undefined }) as typeof config
    expect(restored.api_key).toBe('')
  })

  it('不在 writeOnly 位置上的占位符不换：否则往普通字段里填一个占位符就能把密钥读成明文', () => {
    const restored = restoreSecrets(schema, { ...masked, model: masked.api_key }, config) as typeof config
    expect(restored.model).toBe(masked.api_key)
    expect(restored.api_key).toBe('sk-root')
  })
})

describe('管理 API 的往返', () => {
  const BASE = 'https://bot.test'
  const headers = { authorization: 'Bearer admin-token', 'content-type': 'application/json' }
  const llm = definePlugin<{ api_key: string; model: string }>({
    name: 'llm',
    version: '1.0.0',
    configSchema: { type: 'object', properties: { api_key: { type: 'string', writeOnly: true }, model: { type: 'string' } } },
    defaultConfig: { api_key: '', model: 'm' },
  })

  beforeEach(() => {
    resetSnapshotCache()
    resetLifecycle()
  })

  function setup() {
    const runtime = createRuntime({ plugins: [llm] })
    const env = createEnv()
    env.KV.store.set('rt:snapshot', JSON.stringify({ revision: 1, plugins: { llm: { enabled: true, config: { api_key: 'sk-real', model: 'm' } } } }))
    const call = (path: string, init: RequestInit = {}) => runtime.fetch!(new Request(`${BASE}${path}`, { headers, ...init }), env, createExecutionContext())
    const stored = () => JSON.parse(env.KV.store.get('rt:snapshot')!).plugins.llm.config as Record<string, unknown>
    return { call, stored }
  }

  it('status 只给占位符；原样存回去密钥不变，改了别的字段也不丢', async () => {
    const { call, stored } = setup()
    const status = (await (await call('/admin/status')).json()) as { plugins: Array<{ config: { api_key: string; model: string } }> }
    const config = status.plugins[0]!.config
    expect(isSecretPlaceholder(config.api_key)).toBe(true)

    const res = await call('/admin/plugins/llm', { method: 'PATCH', body: JSON.stringify({ config: { ...config, model: 'n' } }) })
    expect(res.status).toBe(200)
    expect(JSON.stringify(await res.json())).not.toContain('sk-real')
    expect(stored()).toEqual({ api_key: 'sk-real', model: 'n' })
  })

  it('填新值替换，空串清掉', async () => {
    const { call, stored } = setup()
    await call('/admin/plugins/llm', { method: 'PATCH', body: JSON.stringify({ config: { api_key: 'sk-new', model: 'm' } }) })
    expect(stored().api_key).toBe('sk-new')
    await call('/admin/plugins/llm', { method: 'PATCH', body: JSON.stringify({ config: { api_key: '', model: 'm' } }) })
    expect(stored().api_key).toBe('')
  })

  it('GET /admin/snapshot 同样只给占位符，整份 PUT 回去密钥不变', async () => {
    const { call, stored } = setup()
    const { snapshot } = (await (await call('/admin/snapshot')).json()) as { snapshot: { plugins: { llm: { config: { api_key: string } } } } }
    expect(isSecretPlaceholder(snapshot.plugins.llm.config.api_key)).toBe(true)
    const res = await call('/admin/snapshot', { method: 'PUT', body: JSON.stringify(snapshot) })
    expect(res.status).toBe(200)
    expect(stored().api_key).toBe('sk-real')
  })
})
