import type { DeployManifest } from './types.js'

const encoder = new TextEncoder()

export async function sha256(input: string | Uint8Array): Promise<Uint8Array> {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
}

export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await sha256(input))
}

/** 运行时与面板制品实际的 SRI（project() 拉取后算出） */
export interface FrameworkIntegrity {
  core?: string
  ui?: string
}

/**
 * 哈希输入的规范化文本。插件按 name 排序，与清单中的顺序及 enabled 状态无关；
 * 每个插件必须已有 integrity（project() 会在拉取后补齐）。
 *
 * core / ui 的 integrity 给了就一并算进去（`core@<版本>+<integrity>`）：运行时与面板都是从机器人仓库现编的，
 * 改了代码不一定改版本号，只看版本号的话换了运行时哈希却不变，面板上的「投影」看不出线上换过代码。
 * 不给时与以前的规范文本逐字一致。投影哈希只用来展示与打 `workers/tag`，没有地方跨版本比较它。
 */
export function canonicalProjectionInput(manifest: DeployManifest, framework: FrameworkIntegrity = {}): string {
  const withIntegrity = (base: string, integrity: string | undefined) => (integrity ? `${base}+${integrity}` : base)
  const lines = [withIntegrity(`core@${manifest.core.version}`, framework.core)]
  if (manifest.ui) lines.push(withIntegrity(`ui@${manifest.ui.version}`, framework.ui))
  const plugins = [...manifest.plugins].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const p of plugins) {
    if (!p.integrity) throw new Error(`插件 ${p.name}@${p.version} 缺少 integrity，无法计算投影哈希`)
    lines.push(`${p.name}@${p.version}+${p.integrity}`)
  }
  return lines.join('\n')
}

/** 投影哈希：64 位 hex */
export async function computeProjectionHash(manifest: DeployManifest, framework: FrameworkIntegrity = {}): Promise<string> {
  return sha256Hex(canonicalProjectionInput(manifest, framework))
}

/** 胶水中导出的 PROJECTION 常量形式，与 SRI 风格一致，便于运行时对外暴露 */
export function projectionId(hash: string): string {
  return `sha256-${hash}`
}
