/**
 * 向导页面：Vue 写在 scripts/bootstrap/ui，向导启动时现场构建（工作流里 pnpm install 已经跑过），
 * 产物整个读进内存，只按这份清单回文件——请求路径不落到文件系统上，不存在路径穿越。
 *
 * 在向导里构建而不是在工作流里加一步：fork 里的 bootstrap.yml 可能还是旧的，这样新旧工作流都能用。
 */

import { spawn } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

export function uiDir(repoRoot) {
  return path.join(repoRoot, 'scripts', 'bootstrap', 'ui')
}

/** pnpm --filter @qqbot/bootstrap-ui run build；输出直接进日志（里面没有账户信息） */
export function buildUi(repoRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['--filter', '@qqbot/bootstrap-ui', 'run', 'build'], {
      cwd: repoRoot,
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`向导页面构建失败（退出码 ${code}）`))))
  })
}

async function walk(dir, prefix = '') {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...(await walk(path.join(dir, entry.name), rel)))
    else out.push(rel)
  }
  return out
}

/** 把构建产物读成 Map<请求路径, { body, type, immutable }>；带哈希的 assets 可以长缓存 */
export async function loadUi(distDir) {
  const files = new Map()
  for (const rel of await walk(distDir)) {
    const body = await readFile(path.join(distDir, rel))
    files.set(rel, {
      body,
      type: TYPES[path.extname(rel)] ?? 'application/octet-stream',
      immutable: rel.startsWith('/assets/'),
    })
  }
  if (!files.has('/index.html')) throw new Error(`${distDir} 里没有 index.html`)
  return files
}
