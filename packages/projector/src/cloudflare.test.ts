import { describe, expect, it, vi } from 'vitest'
import { makeProjection } from './__fixtures__/manifest.js'
import { CloudflareApiError, CloudflareWorkersApi } from './cloudflare.js'

type Call = { url: string; init: RequestInit }

function fakeApi(responder: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} }
    calls.push(call)
    return responder(call)
  })
  const api = new CloudflareWorkersApi({
    accountId: 'acc123',
    apiToken: 'tok',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  })
  return { api, calls }
}

const ok = (result: unknown) => new Response(JSON.stringify({ success: true, errors: [], result }))

describe('CloudflareWorkersApi.uploadVersion', () => {
  it('POST multipart 到 versions 接口，包含 metadata 与每个模块', async () => {
    const { api, calls } = fakeApi(() => ok({ id: 'ver-1' }))
    const projection = makeProjection({
      modules: { 'index.js': 'export default 1', 'runtime.js': 'export const a = 1', 'plugins/foo.js': 'export {}' },
    })

    const result = await api.uploadVersion({ scriptName: 'my-bot', projection })
    expect(result).toEqual({ versionId: 'ver-1' })

    const call = calls[0]!
    expect(call.url).toBe('https://api.cloudflare.com/client/v4/accounts/acc123/workers/scripts/my-bot/versions')
    expect(call.init.method).toBe('POST')
    expect((call.init.headers as Record<string, string>).authorization).toBe('Bearer tok')
    expect((call.init.headers as Record<string, string>)['content-type']).toBeUndefined()

    const form = call.init.body as FormData
    expect(form).toBeInstanceOf(FormData)
    const metadata = form.get('metadata') as File
    expect(metadata.type).toBe('application/json')
    expect(JSON.parse(await metadata.text())).toEqual(projection.metadata)

    for (const [name, code] of Object.entries(projection.modules)) {
      const part = form.get(name) as File
      expect(part, name).toBeInstanceOf(Blob)
      expect(part.type).toBe('application/javascript+module')
      expect(part.name).toBe(name)
      expect(await part.text()).toBe(code)
    }
    expect([...form.keys()].sort()).toEqual(['index.js', 'metadata', 'plugins/foo.js', 'runtime.js'])
  })

  it('message 覆盖 workers/message 注释', async () => {
    const { api, calls } = fakeApi(() => ok({ id: 'ver-2' }))
    await api.uploadVersion({ scriptName: 's', projection: makeProjection(), message: '手动发布' })
    const metadata = JSON.parse(await ((calls[0]!.init.body as FormData).get('metadata') as File).text())
    expect(metadata.annotations['workers/message']).toBe('手动发布')
    expect(metadata.annotations['workers/tag']).toBe('a'.repeat(20))
  })
})

describe('CloudflareWorkersApi.deployVersion', () => {
  it('POST JSON 到 deployments 接口', async () => {
    const { api, calls } = fakeApi(() => ok({ id: 'dep-1' }))
    const result = await api.deployVersion({ scriptName: 'my-bot', versionId: 'ver-1', message: 'go' })
    expect(result).toEqual({ deploymentId: 'dep-1' })
    const call = calls[0]!
    expect(call.url).toBe('https://api.cloudflare.com/client/v4/accounts/acc123/workers/scripts/my-bot/deployments')
    expect((call.init.headers as Record<string, string>)['content-type']).toBe('application/json')
    expect(JSON.parse(call.init.body as string)).toEqual({
      strategy: 'percentage',
      versions: [{ percentage: 100, version_id: 'ver-1' }],
      annotations: { 'workers/message': 'go' },
    })
  })

  it('无 message 时不带 annotations', async () => {
    const { api, calls } = fakeApi(() => ok({ id: 'dep-1' }))
    await api.deployVersion({ scriptName: 's', versionId: 'v' })
    expect(JSON.parse(calls[0]!.init.body as string)).not.toHaveProperty('annotations')
  })
})

describe('CloudflareWorkersApi.listSecretNames', () => {
  const bindings = [
    { type: 'secret_text', name: 'BOT_SECRET' },
    { type: 'secret_key', name: 'SIGN_KEY' },
    { type: 'secrets_store_secret', name: 'STORED' },
    { type: 'plain_text', name: 'ENV' },
    { type: 'kv_namespace', name: 'KV' },
    { type: 'd1', name: 'DB' },
  ]

  it('不带 versionId 读 settings 接口，只留 secret 类型的名字', async () => {
    const { api, calls } = fakeApi(() => ok({ bindings }))
    expect(await api.listSecretNames({ scriptName: 'my-bot' })).toEqual(['BOT_SECRET', 'SIGN_KEY', 'STORED'])
    expect(calls[0]!.init.method).toBe('GET')
    expect(calls[0]!.url).toBe('https://api.cloudflare.com/client/v4/accounts/acc123/workers/scripts/my-bot/settings')
  })

  it('带 versionId 读对应版本，兼容 resources.bindings 形状', async () => {
    const { api, calls } = fakeApi(() => ok({ resources: { bindings } }))
    expect(await api.listSecretNames({ scriptName: 'my-bot', versionId: 'ver-9' })).toEqual([
      'BOT_SECRET',
      'SIGN_KEY',
      'STORED',
    ])
    expect(calls[0]!.url).toBe('https://api.cloudflare.com/client/v4/accounts/acc123/workers/scripts/my-bot/versions/ver-9')
  })

  it('无 bindings 时返回空数组', async () => {
    const { api } = fakeApi(() => ok({}))
    expect(await api.listSecretNames({ scriptName: 's' })).toEqual([])
  })
})

describe('CloudflareWorkersApi 查询接口', () => {
  it('listVersions / listDeployments / getWorkersSubdomain / previewUrl', async () => {
    const { api, calls } = fakeApi(({ url }) => {
      if (url.endsWith('/versions')) return ok({ items: [{ id: 'v1' }, { id: 'v2' }] })
      if (url.endsWith('/deployments')) return ok({ deployments: [{ id: 'd1', strategy: 'percentage', versions: [] }] })
      if (url.endsWith('/workers/subdomain')) return ok({ subdomain: 'acme' })
      return new Response('not found', { status: 404 })
    })
    expect(await api.listVersions('s')).toEqual([{ id: 'v1' }, { id: 'v2' }])
    expect(await api.listDeployments('s')).toEqual([{ id: 'd1', strategy: 'percentage', versions: [] }])
    expect(await api.getWorkersSubdomain()).toBe('acme')
    expect(calls.map((c) => c.init.method)).toEqual(['GET', 'GET', 'GET'])
    expect(calls[2]!.url).toBe('https://api.cloudflare.com/client/v4/accounts/acc123/workers/subdomain')

    expect(api.previewUrl({ scriptName: 'my-bot', versionId: '0123abcd-4567-89ab-cdef-0123456789ab', subdomain: 'acme' })).toBe(
      'https://0123abcd-my-bot.acme.workers.dev',
    )
  })

  it('自定义 baseUrl 去掉尾部斜杠', async () => {
    const calls: string[] = []
    const api = new CloudflareWorkersApi({
      accountId: 'a',
      apiToken: 't',
      baseUrl: 'https://mock.local/v4/',
      fetchImpl: (async (input: string | URL | Request) => {
        calls.push(String(input))
        return ok({ subdomain: 'x' })
      }) as unknown as typeof fetch,
    })
    await api.getWorkersSubdomain()
    expect(calls[0]).toBe('https://mock.local/v4/accounts/a/workers/subdomain')
  })
})

describe('CloudflareApiError', () => {
  it('失败信封抛 CloudflareApiError，携带 status 与 errors', async () => {
    const { api } = fakeApi(
      () =>
        new Response(
          JSON.stringify({ success: false, errors: [{ code: 10021, message: 'Uncaught SyntaxError' }], result: null }),
          { status: 400 },
        ),
    )
    const err = await api.uploadVersion({ scriptName: 's', projection: makeProjection() }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CloudflareApiError)
    const apiErr = err as CloudflareApiError
    expect(apiErr.status).toBe(400)
    expect(apiErr.errors).toEqual([{ code: 10021, message: 'Uncaught SyntaxError' }])
    expect(apiErr.message).toContain('10021')
  })

  it('HTTP 2xx 但 success=false 也视为失败', async () => {
    const { api } = fakeApi(
      () => new Response(JSON.stringify({ success: false, errors: [{ code: 1, message: 'x' }], result: null })),
    )
    await expect(api.getWorkersSubdomain()).rejects.toBeInstanceOf(CloudflareApiError)
  })

  it('非 JSON 响应包装为 CloudflareApiError', async () => {
    const { api } = fakeApi(() => new Response('<html>502</html>', { status: 502 }))
    const err = (await api.getWorkersSubdomain().catch((e: unknown) => e)) as CloudflareApiError
    expect(err).toBeInstanceOf(CloudflareApiError)
    expect(err.status).toBe(502)
    expect(err.errors).toEqual([])
  })
})
