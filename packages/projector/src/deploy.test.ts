import { describe, expect, it, vi } from 'vitest'
import { makeProjection } from './__fixtures__/manifest.js'
import { CloudflareApiError } from './cloudflare.js'
import { type DeployApi, HealthCheckError, SecretLossError, deploy } from './deploy.js'
import type { DeployStep } from './types.js'

function fakeDeployApi() {
  const api = {
    uploadVersion: vi.fn(async () => ({ versionId: 'ver-1' })),
    deployVersion: vi.fn(async () => ({ deploymentId: 'dep-1' })),
    getWorkersSubdomain: vi.fn(async () => 'acme'),
    previewUrl: vi.fn(({ versionId, scriptName, subdomain }: { versionId: string; scriptName: string; subdomain: string }) =>
      `https://${versionId.slice(0, 8)}-${scriptName}.${subdomain}.workers.dev`),
  }
  return api satisfies DeployApi
}

const healthFetch = (statuses: number[]) => {
  const fn = vi.fn(async () => new Response('', { status: statuses.shift() ?? 200 }))
  return fn as unknown as typeof fetch
}

describe('deploy', () => {
  it('上传 → 健康检查 → 切流量，并按阶段回调', async () => {
    const api = fakeDeployApi()
    const steps: DeployStep[] = []
    const fetchImpl = healthFetch([200])
    const projection = makeProjection()

    const result = await deploy({
      api,
      scriptName: 'my-bot',
      projection,
      message: '发布',
      onProgress: (s) => steps.push(s),
      fetchImpl,
    })

    expect(result).toEqual({ versionId: 'ver-1', hash: projection.hash, previewUrl: 'https://ver-1-my-bot.acme.workers.dev' })
    expect(api.uploadVersion).toHaveBeenCalledWith({ scriptName: 'my-bot', projection, message: '发布' })
    expect(api.deployVersion).toHaveBeenCalledWith({ scriptName: 'my-bot', versionId: 'ver-1', message: '发布' })
    // 默认带 plugins=1：让运行时把插件都求值一遍，import 就抛错的插件在切流量前现形
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      'https://ver-1-my-bot.acme.workers.dev/healthz?plugins=1',
    )
    expect(steps.map((s) => s.stage)).toEqual(['upload', 'upload', 'health', 'health', 'promote', 'done'])
  })

  it('健康检查失败时不 promote，抛 HealthCheckError', async () => {
    const api = fakeDeployApi()
    const fetchImpl = healthFetch([503, 503, 503])

    await expect(
      deploy({
        api,
        scriptName: 's',
        projection: makeProjection(),
        healthCheck: { retries: 3, intervalMs: 0, path: '/ready' },
        fetchImpl,
      }),
    ).rejects.toThrow(HealthCheckError)

    expect(api.uploadVersion).toHaveBeenCalledTimes(1)
    expect(api.deployVersion).not.toHaveBeenCalled()
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3)
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      'https://ver-1-s.acme.workers.dev/ready',
    )
  })

  it('健康检查先失败后成功则继续 promote', async () => {
    const api = fakeDeployApi()
    const fetchImpl = healthFetch([502, 200])
    await deploy({ api, scriptName: 's', projection: makeProjection(), healthCheck: { intervalMs: 0 }, fetchImpl })
    expect(api.deployVersion).toHaveBeenCalledTimes(1)
  })

  it('网络异常也计为一次失败', async () => {
    const api = fakeDeployApi()
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch
    await expect(
      deploy({ api, scriptName: 's', projection: makeProjection(), healthCheck: { retries: 2, intervalMs: 0 }, fetchImpl }),
    ).rejects.toThrow('ECONNRESET')
    expect(api.deployVersion).not.toHaveBeenCalled()
  })

  it('healthCheck: false 跳过检查，不请求 subdomain，结果无 previewUrl', async () => {
    const api = fakeDeployApi()
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const result = await deploy({ api, scriptName: 's', projection: makeProjection(), healthCheck: false, fetchImpl })
    expect(result).toEqual({ versionId: 'ver-1', hash: 'a'.repeat(64) })
    expect(api.getWorkersSubdomain).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(api.deployVersion).toHaveBeenCalledTimes(1)
  })

  it('含 DO 且未显式配置时自动跳过健康检查（平台不生成预览 URL）', async () => {
    const api = fakeDeployApi()
    const steps: DeployStep[] = []
    const projection = makeProjection({
      metadata: {
        ...makeProjection().metadata,
        exports: { P_foo_Game: { type: 'durable-object', storage: 'sqlite' } },
      },
    })
    const fetchImpl = vi.fn() as unknown as typeof fetch
    await deploy({ api, scriptName: 's', projection, fetchImpl, onProgress: (s) => steps.push(s) })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(steps.find((s) => s.stage === 'health')?.message).toContain('Durable Object')
    expect(api.deployVersion).toHaveBeenCalledTimes(1)
  })

  it('503 带 pluginErrors：错误里列出是哪些插件，不切流量（重试次数照旧）', async () => {
    const api = fakeDeployApi()
    const body = JSON.stringify({ ok: false, plugins: 2, pluginErrors: [{ name: 'weather', message: 'boom at import' }, { name: 1 }] })
    const fetchImpl = vi.fn(async () => new Response(body, { status: 503, headers: { 'content-type': 'application/json' } }))
    const err = await deploy({
      api,
      scriptName: 's',
      projection: makeProjection(),
      healthCheck: { retries: 2, intervalMs: 0 },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(HealthCheckError)
    expect((err as HealthCheckError).pluginErrors).toEqual([{ name: 'weather', message: 'boom at import' }])
    expect((err as Error).message).toContain('weather（boom at import）')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(api.deployVersion).not.toHaveBeenCalled()
  })

  it('最后一次是网络抖动时，之前报过的插件加载失败不丢', async () => {
    const api = fakeDeployApi()
    const body = JSON.stringify({ ok: false, pluginErrors: [{ name: 'weather', message: 'boom' }] })
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(body, { status: 503 }))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
    const err = await deploy({
      api,
      scriptName: 's',
      projection: makeProjection(),
      healthCheck: { retries: 2, intervalMs: 0 },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((e: unknown) => e)
    expect((err as HealthCheckError).pluginErrors).toEqual([{ name: 'weather', message: 'boom' }])
    expect((err as Error).message).toContain('ECONNRESET')
    expect((err as Error).message).toContain('weather（boom）')
  })

  it('旧运行时（不认识 plugins=1）或非 JSON 的错误页：pluginErrors 为空，行为同以前', async () => {
    const api = fakeDeployApi()
    const fetchImpl = healthFetch([502])
    const err = await deploy({
      api,
      scriptName: 's',
      projection: makeProjection(),
      healthCheck: { retries: 1, intervalMs: 0 },
      fetchImpl,
    }).catch((e: unknown) => e)
    expect((err as HealthCheckError).pluginErrors).toEqual([])
    expect((err as Error).message).toBe('健康检查失败（1 次）：HTTP 502，未切换流量')
  })

  it('显式给了 path 就原样用，不追加 plugins=1', async () => {
    const api = fakeDeployApi()
    const fetchImpl = healthFetch([200])
    await deploy({ api, scriptName: 's', projection: makeProjection(), healthCheck: { path: '/ready' }, fetchImpl })
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe('https://ver-1-s.acme.workers.dev/ready')
  })

  it('含 DO 但显式传入 healthCheck 对象时仍执行检查', async () => {
    const api = fakeDeployApi()
    const projection = makeProjection({
      metadata: { ...makeProjection().metadata, exports: { X: { type: 'durable-object', storage: 'sqlite' } } },
    })
    const fetchImpl = healthFetch([200])
    await deploy({ api, scriptName: 's', projection, healthCheck: {}, fetchImpl })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('deploy 错误带阶段（调用方据此决定能不能降级）', () => {
  const cfError = (status: number) => new CloudflareApiError(`HTTP ${status}`, status, [])
  const stageOf = (err: unknown) => (err as { stage?: string }).stage

  it('上传失败标 upload', async () => {
    const api = { ...fakeDeployApi(), uploadVersion: vi.fn(async () => Promise.reject(cfError(403))) }
    const err = await deploy({ api, scriptName: 's', projection: makeProjection(), healthCheck: false }).catch((e: unknown) => e)
    expect(stageOf(err)).toBe('upload')
  })

  it('版本上传之后的每一步都标出自己的阶段——这些 403 不能降级（会绕过健康检查）', async () => {
    const subdomain = { ...fakeDeployApi(), getWorkersSubdomain: vi.fn(async () => Promise.reject(cfError(403))) }
    const e1 = await deploy({ api: subdomain, scriptName: 's', projection: makeProjection(), healthCheck: {} }).catch((e: unknown) => e)
    expect(stageOf(e1)).toBe('subdomain')
    expect(subdomain.deployVersion).not.toHaveBeenCalled()

    const promote = { ...fakeDeployApi(), deployVersion: vi.fn(async () => Promise.reject(cfError(403))) }
    const e2 = await deploy({ api: promote, scriptName: 's', projection: makeProjection(), healthCheck: false }).catch((e: unknown) => e)
    expect(stageOf(e2)).toBe('promote')

    const health = await deploy({
      api: fakeDeployApi(),
      scriptName: 's',
      projection: makeProjection(),
      healthCheck: { retries: 1, intervalMs: 0 },
      fetchImpl: healthFetch([500]),
    }).catch((e: unknown) => e)
    expect(stageOf(health)).toBe('health')

    const secrets = {
      ...fakeDeployApi(),
      listSecretNames: vi.fn().mockResolvedValueOnce(['A']).mockResolvedValueOnce([]),
    }
    const e3 = await deploy({ api: secrets, scriptName: 's', projection: makeProjection(), healthCheck: false }).catch((e: unknown) => e)
    expect(e3).toBeInstanceOf(SecretLossError)
    expect(stageOf(e3)).toBe('secrets')
  })
})

describe('deploy secret 保全校验', () => {
  it('secret 原样保留 → 继续 promote，先读当前名单再读新版本名单', async () => {
    const api = {
      ...fakeDeployApi(),
      listSecretNames: vi
        .fn()
        .mockResolvedValueOnce(['A', 'B']) // 上传前：当前生效的 settings
        .mockResolvedValueOnce(['B', 'A', 'C']), // 上传后：新版本（多出的不算丢）
    }
    const steps: DeployStep[] = []
    await deploy({ api, scriptName: 's', projection: makeProjection(), healthCheck: false, onProgress: (s) => steps.push(s) })

    expect(api.deployVersion).toHaveBeenCalledTimes(1)
    expect(api.listSecretNames).toHaveBeenNthCalledWith(1, { scriptName: 's' })
    expect(api.listSecretNames).toHaveBeenNthCalledWith(2, { scriptName: 's', versionId: 'ver-1' })
    expect(steps.map((s) => s.message).some((m) => m.includes('保全校验通过'))).toBe(true)
  })

  it('丢了 secret → 抛 SecretLossError，不切流量', async () => {
    const api = {
      ...fakeDeployApi(),
      listSecretNames: vi.fn().mockResolvedValueOnce(['A', 'B']).mockResolvedValueOnce(['A']),
    }
    const err = await deploy({ api, scriptName: 's', projection: makeProjection(), healthCheck: false }).catch(
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(SecretLossError)
    expect((err as SecretLossError).missing).toEqual(['B'])
    expect((err as Error).message).toContain('未切换流量')
    expect(api.uploadVersion).toHaveBeenCalledTimes(1)
    expect(api.deployVersion).not.toHaveBeenCalled()
  })

  it('上传前读不到名单 → 告警并跳过校验，继续 promote', async () => {
    const api = {
      ...fakeDeployApi(),
      listSecretNames: vi.fn(async () => {
        throw new Error('无权限')
      }),
    }
    const steps: DeployStep[] = []
    await deploy({ api, scriptName: 's', projection: makeProjection(), healthCheck: false, onProgress: (s) => steps.push(s) })

    expect(api.listSecretNames).toHaveBeenCalledTimes(1)
    expect(api.deployVersion).toHaveBeenCalledTimes(1)
    expect(steps.filter((s) => s.stage === 'upload').some((s) => s.message.includes('跳过保全校验'))).toBe(true)
  })

  it('上传后读不到新版本名单 → 告警并跳过校验，继续 promote', async () => {
    const api = {
      ...fakeDeployApi(),
      listSecretNames: vi.fn().mockResolvedValueOnce(['A']).mockRejectedValueOnce(new Error('boom')),
    }
    const steps: DeployStep[] = []
    await deploy({ api, scriptName: 's', projection: makeProjection(), healthCheck: false, onProgress: (s) => steps.push(s) })

    expect(api.listSecretNames).toHaveBeenCalledTimes(2)
    expect(api.deployVersion).toHaveBeenCalledTimes(1)
    expect(steps.filter((s) => s.stage === 'upload').some((s) => s.message.includes('跳过保全校验'))).toBe(true)
  })
})
