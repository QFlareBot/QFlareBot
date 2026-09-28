/** cloudflared（网页向导的 Quick Tunnel）：钉死版本、核对校验和 */

import { createHash } from 'node:crypto'
import { BootstrapError } from './cf.mjs'

/**
 * 钉死版本、下载后核对 sha256。以前取 releases/latest 且不校验：发布渠道出了岔子，runner 上跑的就是
 * 别人的二进制，而向导进程手里握着用户的 Cloudflare token。
 * 升级：改版本号，把两个校验和一起换掉——发布页的说明里每个文件都列了 sha256，也可以
 * `gh api repos/cloudflare/cloudflared/releases/tags/<版本> --jq '.assets[] | .name + " " + .digest'`。
 */
export const CLOUDFLARED_VERSION = '2026.9.3'

/** process.arch → 发布文件；GitHub 托管的 runner 是 linux x64，自托管的 ARM runner 用 arm64 */
export const CLOUDFLARED_ASSETS = {
  x64: { file: 'cloudflared-linux-amd64', sha256: '77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2' },
  arm64: { file: 'cloudflared-linux-arm64', sha256: 'aaeb2d7d0da3614634c7e03ab13487a1522c2e79165ed2929cfe23d5e95b326d' },
}

/** 下载这个架构的 cloudflared 并核对校验和，返回文件内容；对不上就抛错，不落盘 */
export async function downloadCloudflared({ arch = process.arch, version = CLOUDFLARED_VERSION, assets = CLOUDFLARED_ASSETS } = {}) {
  const asset = assets[arch]
  if (!asset) throw new BootstrapError(`不支持的 runner 架构 ${arch}：cloudflared 只准备了 ${Object.keys(assets).join(' / ')}`)
  const res = await fetch(`https://github.com/cloudflare/cloudflared/releases/download/${version}/${asset.file}`, { redirect: 'follow' })
  if (!res.ok) throw new BootstrapError(`下载 cloudflared 失败：HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const digest = createHash('sha256').update(buf).digest('hex')
  if (digest !== asset.sha256) {
    throw new BootstrapError(`cloudflared ${version} 校验和不符（期望 ${asset.sha256}，实际 ${digest}），拒绝运行`)
  }
  return buf
}
