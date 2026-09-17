import { describe, expect, it, vi } from 'vitest'
import {
  ArtifactError,
  IntegrityError,
  computeIntegrity,
  createHttpFetcher,
  listNpmVersions,
  parseSource,
  resolveArtifactUrl,
  verifyIntegrity,
} from './artifacts.js'

describe('parseSource / resolveArtifactUrl', () => {
  it('npm：jsdelivr，runtime 与 plugin 文件名不同', () => {
    expect(
      resolveArtifactUrl({ kind: 'plugin', name: 'foo', version: '1.2.3', source: 'npm:@qqbot/plugin-foo' }),
    ).toBe('https://cdn.jsdelivr.net/npm/@qqbot/plugin-foo@1.2.3/dist/plugin.js')
    expect(
      resolveArtifactUrl({ kind: 'runtime', name: '@qqbot/runtime', version: '0.3.0', source: 'npm:@qqbot/runtime' }),
    ).toBe('https://cdn.jsdelivr.net/npm/@qqbot/runtime@0.3.0/dist/runtime.js')
  })

  it('npm：内嵌版本被忽略，以 ref.version 为准', () => {
    expect(resolveArtifactUrl({ kind: 'plugin', name: 'x', version: '2.0.0', source: 'npm:foo@1.0.0' })).toBe(
      'https://cdn.jsdelivr.net/npm/foo@2.0.0/dist/plugin.js',
    )
  })

  it('github：release 资产', () => {
    expect(resolveArtifactUrl({ kind: 'plugin', name: 'x', version: '1.0.0', source: 'github:acme/qq-plugin' })).toBe(
      'https://github.com/acme/qq-plugin/releases/download/v1.0.0/plugin.js',
    )
    expect(() => resolveArtifactUrl({ kind: 'plugin', name: 'x', version: '1.0.0', source: 'github:bad' })).toThrow(
      ArtifactError,
    )
  })

  it('url：原样返回；非 http(s) 拒绝', () => {
    expect(
      resolveArtifactUrl({ kind: 'plugin', name: 'x', version: '1', source: 'url:https://example.com/a/plugin.js' }),
    ).toBe('https://example.com/a/plugin.js')
    expect(() => resolveArtifactUrl({ kind: 'plugin', name: 'x', version: '1', source: 'url:ftp://x/y' })).toThrow(
      ArtifactError,
    )
  })

  it('file：核心库不支持', () => {
    expect(() => resolveArtifactUrl({ kind: 'plugin', name: 'x', version: '1', source: 'file:./a.js' })).toThrow(
      'file:',
    )
  })

  it('未知 scheme 抛错', () => {
    expect(() => parseSource('ipfs:abc')).toThrow(ArtifactError)
    expect(() => parseSource('npm:')).toThrow(ArtifactError)
    expect(parseSource('url:https://a/b')).toEqual({ scheme: 'url', value: 'https://a/b' })
  })
})

describe('integrity', () => {
  it('computeIntegrity 为 sha256-<base64>', async () => {
    // sha256('abc') 的 base64
    expect(await computeIntegrity('abc')).toBe('sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=')
  })

  it('verifyIntegrity 匹配通过、不匹配抛 IntegrityError', async () => {
    const code = 'export default 1'
    await expect(verifyIntegrity(code, await computeIntegrity(code))).resolves.toBeUndefined()
    await expect(verifyIntegrity(code, 'sha256-bad', '插件 x')).rejects.toThrow(IntegrityError)
    await expect(verifyIntegrity(code, 'sha256-bad', '插件 x')).rejects.toThrow('插件 x')
  })
})

describe('createHttpFetcher', () => {
  it('请求解析出的 URL 并返回文本', async () => {
    const fetchImpl = vi.fn(async (_url: string) => new Response('export default 1'))
    const fetchArtifact = createHttpFetcher(fetchImpl as unknown as typeof fetch)
    const code = await fetchArtifact({ kind: 'plugin', name: 'foo', version: '1.0.0', source: 'npm:foo' })
    expect(code).toBe('export default 1')
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://cdn.jsdelivr.net/npm/foo@1.0.0/dist/plugin.js')
  })

  it('非 2xx 抛 ArtifactError', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 }))
    const fetchArtifact = createHttpFetcher(fetchImpl as unknown as typeof fetch)
    await expect(fetchArtifact({ kind: 'plugin', name: 'foo', version: '1.0.0', source: 'npm:foo' })).rejects.toThrow(
      'HTTP 404',
    )
  })
})

describe('listNpmVersions', () => {
  it('scoped 包名编码，返回版本列表与 latest', async () => {
    const fetchImpl = vi.fn(
      async (_url: string) =>
        new Response(
          JSON.stringify({ versions: { '1.0.0': {}, '1.1.0': {} }, 'dist-tags': { latest: '1.1.0' } }),
        ),
    )
    const result = await listNpmVersions('@qqbot/plugin-foo', fetchImpl as unknown as typeof fetch)
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://registry.npmjs.org/@qqbot%2Fplugin-foo')
    expect(result).toEqual({ versions: ['1.0.0', '1.1.0'], latest: '1.1.0' })
  })

  it('无 dist-tags 时不带 latest', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ versions: { '0.1.0': {} } })))
    const result = await listNpmVersions('foo', fetchImpl as unknown as typeof fetch)
    expect(result).toEqual({ versions: ['0.1.0'] })
  })
})
