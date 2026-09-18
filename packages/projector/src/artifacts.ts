import { validateManifest, type Manifest } from '@qqbot/sdk'
import { sha256, toBase64 } from './hash.js'
import type { ArtifactRef, FetchArtifact } from './types.js'

export class ArtifactError extends Error {
  override readonly name = 'ArtifactError'
}

export class IntegrityError extends Error {
  override readonly name = 'IntegrityError'
  constructor(
    label: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`${label} 完整性校验失败：期望 ${expected}，实际 ${actual}`)
  }
}

export type SourceScheme = 'npm' | 'github' | 'url' | 'file'
export interface ParsedSource {
  scheme: SourceScheme
  value: string
}

const SCHEMES: readonly SourceScheme[] = ['npm', 'github', 'url', 'file']

export function parseSource(source: string): ParsedSource {
  const idx = source.indexOf(':')
  const scheme = idx > 0 ? source.slice(0, idx) : ''
  const value = source.slice(idx + 1)
  if (!(SCHEMES as readonly string[]).includes(scheme) || !value) {
    throw new ArtifactError(`不支持的制品来源：${source}`)
  }
  return { scheme: scheme as SourceScheme, value }
}

/** 一次拉取要的是代码还是插件清单 */
export type ArtifactAsset = 'code' | 'manifest'

const MANIFEST_FILE = 'manifest.json'

function artifactFileName(ref: ArtifactRef, asset: ArtifactAsset): string {
  if (asset === 'manifest') {
    // 只有插件有 manifest.json，runtime / ui 没有
    if (ref.kind !== 'plugin') throw new ArtifactError(`${ref.kind} 没有 ${MANIFEST_FILE}`)
    return MANIFEST_FILE
  }
  return ref.kind === 'runtime' ? 'runtime.js' : ref.kind === 'ui' ? 'ui.js' : 'plugin.js'
}

/** 去掉 `npm:pkg@x.y.z` 中内嵌的版本，版本一律取自 ref.version */
function npmPackageName(value: string): string {
  const at = value.indexOf('@', 1)
  return at > 0 ? value.slice(0, at) : value
}

/** `url:` 指向的是代码文件，清单取同目录下的 manifest.json */
function siblingManifestUrl(url: URL): URL {
  const next = new URL(url.href)
  next.search = ''
  next.hash = ''
  const slash = next.pathname.lastIndexOf('/')
  next.pathname = `${slash >= 0 ? next.pathname.slice(0, slash + 1) : '/'}${MANIFEST_FILE}`
  return next
}

export function resolveArtifactUrl(ref: ArtifactRef, asset: ArtifactAsset = 'code'): string {
  const { scheme, value } = parseSource(ref.source)
  const file = artifactFileName(ref, asset)
  switch (scheme) {
    case 'npm':
      return `https://cdn.jsdelivr.net/npm/${npmPackageName(value)}@${ref.version}/dist/${file}`
    case 'github': {
      if (!/^[\w.-]+\/[\w.-]+$/.test(value)) throw new ArtifactError(`github 来源需为 owner/repo：${ref.source}`)
      return `https://github.com/${value}/releases/download/v${ref.version}/${file}`
    }
    case 'url': {
      let url: URL
      try {
        url = new URL(value)
      } catch {
        throw new ArtifactError(`url 来源不是合法 URL：${ref.source}`)
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new ArtifactError(`url 来源仅支持 http(s)：${ref.source}`)
      }
      return (asset === 'manifest' ? siblingManifestUrl(url) : url).toString()
    }
    case 'file':
      throw new ArtifactError(`file: 来源仅 CLI 本地构建支持：${ref.source}`)
  }
}

export function createHttpFetcher(fetchImpl: typeof fetch = fetch): FetchArtifact {
  return async (ref) => {
    const url = resolveArtifactUrl(ref)
    const res = await fetchImpl(url, { redirect: 'follow' })
    if (!res.ok) {
      throw new ArtifactError(`拉取 ${ref.kind} ${ref.name}@${ref.version} 失败：HTTP ${res.status} ${url}`)
    }
    return res.text()
  }
}

/**
 * 拉插件的 manifest.json。安装时必须先拿到它：撞名检测、依赖检查与面板配置表单
 * 都发生在部署之前，那时 bundle 里还没有这个插件。
 */
export async function fetchPluginManifest(ref: ArtifactRef, fetchImpl: typeof fetch = fetch): Promise<Manifest> {
  const url = resolveArtifactUrl(ref, 'manifest')
  const res = await fetchImpl(url, { redirect: 'follow' })
  if (!res.ok) {
    throw new ArtifactError(`拉取 ${ref.name}@${ref.version} 的清单失败：HTTP ${res.status} ${url}`)
  }
  let manifest: Manifest
  try {
    manifest = JSON.parse(await res.text()) as Manifest
  } catch {
    throw new ArtifactError(`${ref.name}@${ref.version} 的清单不是合法 JSON：${url}`)
  }
  const errors = validateManifest(manifest)
  if (errors.length > 0) {
    throw new ArtifactError(`${ref.name}@${ref.version} 的清单非法：${errors.join('；')}`)
  }
  // 清单自述的名字/版本必须与安装请求一致，否则装进来的东西与记录的对不上
  if (manifest.name !== ref.name) {
    throw new ArtifactError(`清单里的 name 是 ${manifest.name}，与安装的 ${ref.name} 不一致`)
  }
  if (manifest.version !== ref.version) {
    throw new ArtifactError(`清单里的 version 是 ${manifest.version}，与安装的 ${ref.version} 不一致`)
  }
  return manifest
}

/** SRI 格式 `sha256-<base64>` */
export async function computeIntegrity(code: string): Promise<string> {
  return `sha256-${toBase64(await sha256(code))}`
}

export async function verifyIntegrity(code: string, expected: string, label = '制品'): Promise<void> {
  const actual = await computeIntegrity(code)
  if (actual !== expected) throw new IntegrityError(label, expected, actual)
}

export interface NpmVersions {
  versions: string[]
  latest?: string
}

export async function listNpmVersions(pkg: string, fetchImpl: typeof fetch = fetch): Promise<NpmVersions> {
  const url = `https://registry.npmjs.org/${pkg.startsWith('@') ? pkg.replace('/', '%2F') : pkg}`
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new ArtifactError(`查询 npm 包 ${pkg} 失败：HTTP ${res.status}`)
  const data = (await res.json()) as {
    versions?: Record<string, unknown>
    'dist-tags'?: Record<string, string>
  }
  const latest = data['dist-tags']?.['latest']
  return {
    versions: Object.keys(data.versions ?? {}),
    ...(latest ? { latest } : {}),
  }
}
