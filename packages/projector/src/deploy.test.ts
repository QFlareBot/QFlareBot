import { describe, expect, it, vi } from 'vitest'
import { makeProjection } from './__fixtures__/manifest.js'
import { type DeployApi, HealthCheckError, deploy } from './deploy.js'
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
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      'https://ver-1-my-bot.acme.workers.dev/healthz',
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
