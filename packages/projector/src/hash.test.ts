import { describe, expect, it } from 'vitest'
import { makeDeployManifest } from './__fixtures__/manifest.js'
import { canonicalProjectionInput, computeProjectionHash, projectionId, sha256Hex, toBase64, toHex } from './hash.js'

describe('sha256 helpers', () => {
  it('sha256Hex 与已知向量一致', async () => {
    expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('toHex / toBase64', () => {
    const bytes = new Uint8Array([0, 1, 255, 16])
    expect(toHex(bytes)).toBe('0001ff10')
    expect(toBase64(bytes)).toBe('AAH/EA==')
  })
})

describe('computeProjectionHash', () => {
  it('插件顺序不同结果相同；enabled 不影响', async () => {
    const a = makeDeployManifest()
    const b = makeDeployManifest()
    b.plugins.reverse()
    for (const p of b.plugins) p.enabled = !p.enabled
    expect(await computeProjectionHash(a)).toBe(await computeProjectionHash(b))
    expect(await computeProjectionHash(a)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('改动版本、integrity 或 core 版本后结果不同', async () => {
    const base = await computeProjectionHash(makeDeployManifest())

    const v = makeDeployManifest()
    v.plugins[0]!.version = '1.2.1'
    expect(await computeProjectionHash(v)).not.toBe(base)

    const i = makeDeployManifest()
    i.plugins[0]!.integrity = 'sha256-other'
    expect(await computeProjectionHash(i)).not.toBe(base)

    const c = makeDeployManifest()
    c.core.version = '0.4.0'
    expect(await computeProjectionHash(c)).not.toBe(base)
  })

  it('缺 integrity 时抛错', () => {
    const m = makeDeployManifest()
    delete m.plugins[0]!.integrity
    expect(() => canonicalProjectionInput(m)).toThrow('integrity')
  })

  it('规范化文本按 name 排序', () => {
    expect(canonicalProjectionInput(makeDeployManifest())).toBe(
      'core@0.3.0\nbar@2.0.0+sha256-YmFy\nfoo@1.2.0+sha256-Zm9v',
    )
  })

  it('给了 core / ui 的 integrity 就一并进规范文本；不给时与以前逐字一致', async () => {
    const withUi = { ...makeDeployManifest(), ui: { version: '0.1.0' } }
    expect(canonicalProjectionInput(withUi, { core: 'sha256-cmVudA==', ui: 'sha256-dWk=' })).toBe(
      'core@0.3.0+sha256-cmVudA==\nui@0.1.0+sha256-dWk=\nbar@2.0.0+sha256-YmFy\nfoo@1.2.0+sha256-Zm9v',
    )
    expect(canonicalProjectionInput(withUi)).toBe('core@0.3.0\nui@0.1.0\nbar@2.0.0+sha256-YmFy\nfoo@1.2.0+sha256-Zm9v')

    // 版本号不变、运行时内容变了：哈希必须不同
    const a = await computeProjectionHash(makeDeployManifest(), { core: 'sha256-a' })
    const b = await computeProjectionHash(makeDeployManifest(), { core: 'sha256-b' })
    expect(a).not.toBe(b)
  })

  it('projectionId 加 sha256- 前缀', () => {
    expect(projectionId('abc')).toBe('sha256-abc')
  })
})
