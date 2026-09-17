import { describe, expect, it, vi } from 'vitest'
import { bindings, makeDeployManifest, makePlugin } from './__fixtures__/manifest.js'
import { IntegrityError, computeIntegrity } from './artifacts.js'
import { computeProjectionHash } from './hash.js'
import { project } from './project.js'
import type { ArtifactRef, DeployManifest } from './types.js'

const CODE: Record<string, string> = {
  runtime: 'export function createRuntime() { return {} }',
  foo: 'export class Game {}\nexport default {}',
  bar: 'export default {}',
}

function fetcher() {
  return vi.fn(async (ref: ArtifactRef) => {
    const code = CODE[ref.kind === 'runtime' ? 'runtime' : ref.name]
    if (!code) throw new Error(`no artifact for ${ref.name}`)
    return code
  })
}

async function manifestWithRealIntegrity(): Promise<DeployManifest> {
  const manifest = makeDeployManifest()
  for (const p of manifest.plugins) p.integrity = await computeIntegrity(CODE[p.name] as string)
  return manifest
}

describe('project', () => {
  it('输出入口、runtime 与插件模块，元数据与 hash 一致', async () => {
    const manifest = await manifestWithRealIntegrity()
    const fetchArtifact = fetcher()
    const result = await project({ manifest, fetchArtifact, bindings, compatibilityDate: '2025-09-01' })

    expect(result.mainModule).toBe('index.js')
    expect(Object.keys(result.modules).sort()).toEqual(['index.js', 'plugins/bar.js', 'plugins/foo.js', 'runtime.js'])
    expect(result.modules['runtime.js']).toBe(CODE['runtime'])
    expect(result.modules['plugins/foo.js']).toBe(CODE['foo'])
    expect(result.modules['index.js']).toContain(`const PROJECTION = "sha256-${result.hash}"`)
    expect(result.hash).toBe(await computeProjectionHash(manifest))
    expect(result.metadata.annotations['workers/tag']).toBe(result.hash.slice(0, 20))
    expect(result.metadata.exports).toEqual({ P_foo_Game: { type: 'durable-object', storage: 'sqlite' } })
    expect(result.integrity.plugins).toEqual({ foo: manifest.plugins[0]!.integrity, bar: manifest.plugins[1]!.integrity })
    expect(result.integrity.core).toBe(await computeIntegrity(CODE['runtime'] as string))

    const refs = fetchArtifact.mock.calls.map(([ref]) => ref)
    expect(refs[0]).toEqual({ kind: 'runtime', name: '@qqbot/runtime', version: '0.3.0', source: 'npm:@qqbot/runtime' })
    expect(refs.slice(1).map((r) => r.name)).toEqual(['bar', 'foo'])
  })

  it('缺 integrity 时首次拉取计算并写入 hash', async () => {
    const manifest = makeDeployManifest()
    for (const p of manifest.plugins) delete p.integrity
    const result = await project({ manifest, fetchArtifact: fetcher(), bindings, compatibilityDate: '2025-09-01' })
    const expected = await manifestWithRealIntegrity()
    expect(result.integrity.plugins['foo']).toBe(expected.plugins[0]!.integrity)
    expect(result.hash).toBe(await computeProjectionHash(expected))
  })

  it('integrity 不匹配时抛 IntegrityError', async () => {
    const manifest = makeDeployManifest()
    await expect(
      project({ manifest, fetchArtifact: fetcher(), bindings, compatibilityDate: '2025-09-01' }),
    ).rejects.toThrow(IntegrityError)
  })

  it('core.source 与 compatibilityFlags/message 透传', async () => {
    const manifest = await manifestWithRealIntegrity()
    manifest.core.source = 'file:../runtime/dist/runtime.js'
    const fetchArtifact = fetcher()
    const result = await project({
      manifest,
      fetchArtifact,
      bindings,
      compatibilityDate: '2025-09-01',
      compatibilityFlags: ['nodejs_compat'],
      message: 'msg',
    })
    expect(fetchArtifact.mock.calls[0]?.[0].source).toBe('file:../runtime/dist/runtime.js')
    expect(result.metadata.compatibility_flags).toEqual(['nodejs_compat'])
    expect(result.metadata.annotations['workers/message']).toBe('msg')
  })

  it('插件名重复时在拉取前就报错', async () => {
    const manifest = makeDeployManifest()
    manifest.plugins.push(makePlugin('foo'))
    const fetchArtifact = fetcher()
    await expect(project({ manifest, fetchArtifact, bindings, compatibilityDate: '2025-09-01' })).rejects.toThrow('重复')
    expect(fetchArtifact).not.toHaveBeenCalled()
  })
})
