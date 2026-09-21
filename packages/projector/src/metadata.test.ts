import { describe, expect, it } from 'vitest'
import { bindings, makeDeployManifest } from './__fixtures__/manifest.js'
import { buildVersionMetadata } from './metadata.js'

const HASH = 'f'.repeat(64)

describe('buildVersionMetadata', () => {
  const metadata = buildVersionMetadata({
    manifest: makeDeployManifest(),
    bindings,
    compatibilityDate: '2025-09-01',
    compatibilityFlags: ['nodejs_compat'],
    hash: HASH,
  })

  it('基础字段', () => {
    expect(metadata.main_module).toBe('index.js')
    expect(metadata.compatibility_date).toBe('2025-09-01')
    expect(metadata.compatibility_flags).toEqual(['nodejs_compat'])
  })

  it('bindings 包含 KV/D1/R2/vars 与插件 DO', () => {
    expect(metadata.bindings).toEqual([
      { type: 'kv_namespace', name: 'KV', namespace_id: 'kv-id' },
      { type: 'd1', name: 'DB', database_id: 'd1-id' },
      { type: 'r2_bucket', name: 'R2', bucket_name: 'bucket' },
      { type: 'plain_text', name: 'ENV', text: 'prod' },
      { type: 'durable_object_namespace', name: 'P_foo_Game', class_name: 'P_foo_Game' },
    ])
  })

  it('keep_bindings 声明按类型保留 secret（缺了它每次上传都会清空 Worker 上的 secret）', () => {
    expect(metadata.keep_bindings).toEqual(['secret_text', 'secret_key', 'secrets_store_secret'])
  })

  it('exports 声明 sqlite DO', () => {
    expect(metadata.exports).toEqual({ P_foo_Game: { type: 'durable-object', storage: 'sqlite' } })
  })

  it('annotations：tag 为 hash 前 20 位，message 缺省自动生成', () => {
    expect(metadata.annotations['workers/tag']).toBe(HASH.slice(0, 20))
    expect(metadata.annotations['workers/message']).toContain('core 0.3.0')
    expect(metadata.annotations['workers/message']).toContain('2 plugins')
  })

  it('无 DO、无 r2/vars/flags 时不出现对应字段', () => {
    const manifest = makeDeployManifest()
    manifest.plugins = manifest.plugins.filter((p) => p.name === 'bar')
    const m = buildVersionMetadata({
      manifest,
      bindings: { kv: bindings.kv, d1: bindings.d1 },
      compatibilityDate: '2025-09-01',
      hash: HASH,
      message: '自定义',
    })
    expect(m).not.toHaveProperty('exports')
    expect(m).not.toHaveProperty('compatibility_flags')
    expect(m.keep_bindings).toEqual(['secret_text', 'secret_key', 'secrets_store_secret'])
    expect(m.bindings.map((b) => b.type)).toEqual(['kv_namespace', 'd1'])
    expect(m.annotations['workers/message']).toBe('自定义')
  })

  it('D1 或 R2 为占位符时不在 VersionMetadata 中注入绑定', () => {
    const manifest = makeDeployManifest()
    const m = buildVersionMetadata({
      manifest,
      bindings: {
        kv: { binding: 'KV', namespaceId: 'real-kv' },
        d1: { binding: 'DB', databaseId: '<provisioned>' },
        r2: { binding: 'R2', bucketName: '<provisioned>' },
      },
      compatibilityDate: '2025-09-01',
      hash: HASH,
    })
    const types = m.bindings.map((b) => b.type)
    expect(types).toContain('kv_namespace')
    expect(types).not.toContain('d1')
    expect(types).not.toContain('r2_bucket')
  })
})
