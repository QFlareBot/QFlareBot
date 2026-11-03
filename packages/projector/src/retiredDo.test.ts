import { describe, expect, it } from 'vitest'
import { bindings, makePlugin } from './__fixtures__/manifest.js'
import { CloudflareWorkersApi } from './cloudflare.js'
import { project } from './project.js'
import { generateWranglerConfig } from './wrangler.js'
import type { DeployManifest, Projection, VersionMetadata } from './types.js'

/**
 * 卸载带 DO 的插件后，部署不能失败（Cloudflare 错误码 10064）。
 *
 * 平台要求显式声明「删除这个类」——声明式 exports 模型下的写法是一条墓碑。
 * 这份名单由 Worker 卸载时记进 D1，构建机随清单取回，这里验证它被正确转成墓碑。
 *
 * 最容易漏的是「卸载最后一个带 DO 的插件」那条分支：没有 live 类时
 * `generateWranglerConfig` 会走 else 分支，早退掉就一条墓碑都不会生成。
 */

function proj(retired?: Array<{ className: string; plugin: string }>): Projection {
  return {
    mainModule: 'index.js',
    modules: {},
    hash: 'abc',
    metadata: { main_module: 'index.js', compatibility_date: '2026-09-01', bindings: [], exports: {} } as never,
    integrity: { core: 'sha256-x', plugins: {} },
    ...(retired ? { retiredDoClasses: retired } : {}),
  }
}

const base = { name: 'qqbot', compatibility_date: '2026-09-01' }

describe('已卸载插件的 DO 墓碑', () => {
  it('卸载后没有 live 类时，仍然生成墓碑（这条分支以前会早退）', () => {
    const config = generateWranglerConfig({
      base,
      projection: proj([{ className: 'P_agent_Agent', plugin: 'agent' }]),
      mainPath: 'index.js',
    })
    expect(config.exports).toEqual({
      P_agent_Agent: { type: 'durable-object', state: 'deleted' },
    })
  })

  it('还有 live 类时，live 与墓碑共存', () => {
    const p = proj([{ className: 'P_agent_Agent', plugin: 'agent' }])
    p.metadata.exports = { P_game_Room: { type: 'durable-object', storage: 'sqlite' } }
    const config = generateWranglerConfig({ base, projection: p, mainPath: 'index.js' })
    expect(config.exports).toMatchObject({
      P_game_Room: { type: 'durable-object', storage: 'sqlite' },
      P_agent_Agent: { type: 'durable-object', state: 'deleted' },
    })
  })

  it('类又回来了（重装同名插件）：以 live 为准，不能同时声明删除', () => {
    const p = proj([{ className: 'P_agent_Agent', plugin: 'agent' }])
    p.metadata.exports = { P_agent_Agent: { type: 'durable-object', storage: 'sqlite' } }
    const config = generateWranglerConfig({ base, projection: p, mainPath: 'index.js' })
    expect(config.exports).toEqual({ P_agent_Agent: { type: 'durable-object', storage: 'sqlite' } })
  })

  it('没有退役名单时不写 exports（老部署行为不变）', () => {
    const config = generateWranglerConfig({ base, projection: proj(), mainPath: 'index.js' })
    expect(config.exports).toBeUndefined()
  })
})

describe('退役 DO 类进入生产上传元数据', () => {
  it.each([
    {
      name: '卸载最后一个 DO 类', live: false, className: 'P_old_Room',
      expected: { P_old_Room: { type: 'durable-object', state: 'deleted' } },
    },
    {
      name: '存活类与退役类并存', live: true, className: 'P_old_Room',
      expected: {
        P_foo_Game: { type: 'durable-object', storage: 'sqlite' },
        P_old_Room: { type: 'durable-object', state: 'deleted' },
      },
    },
    {
      name: '重新装回同名类', live: true, className: 'P_foo_Game',
      expected: { P_foo_Game: { type: 'durable-object', storage: 'sqlite' } },
    },
  ])('$name', async ({ live, className, expected }) => {
    const manifest: DeployManifest = {
      core: { version: '0.7.2' },
      plugins: live ? [makePlugin('foo', { manifest: { durableObjects: ['Game'] } })] : [],
      retiredDoClasses: [{ plugin: 'old', className }],
    }
    const options = { bindings, compatibilityDate: '2026-09-01', fetchArtifact: async () => 'export {}' }
    const projection = await project({ ...options, manifest })
    const withoutRetired = await project({ ...options, manifest: { ...manifest, retiredDoClasses: [] } })
    expect(projection.hash).toBe(withoutRetired.hash)
    expect(projection.modules).toEqual(withoutRetired.modules)

    // CLI 先把元数据写入 projection.json，部署进程再读回并上传 multipart。
    const serialized: Projection = JSON.parse(JSON.stringify(projection))
    let uploaded: VersionMetadata | undefined
    const api = new CloudflareWorkersApi({
      accountId: 'test-account',
      apiToken: 'test-token',
      fetchImpl: async (_input, init) => {
        const metadata = (init!.body as FormData).get('metadata') as Blob
        uploaded = JSON.parse(await metadata.text())
        return Response.json({ success: true, result: { id: 'test-version' } })
      },
    })
    await api.uploadVersion({ scriptName: 'test-worker', projection: serialized })
    expect(uploaded?.exports).toEqual(expected)
    expect(uploaded?.bindings.filter(b => b.type === 'durable_object_namespace')).toEqual(
      live ? [{ type: 'durable_object_namespace', name: 'P_foo_Game', class_name: 'P_foo_Game' }] : [],
    )

    const generated = generateWranglerConfig({ base, projection, mainPath: 'index.js' })
    expect(generated.exports).toEqual(expected)
    expect(generated.durable_objects?.bindings?.map(b => b.class_name) ?? []).toEqual(live ? ['P_foo_Game'] : [])
  })
})
