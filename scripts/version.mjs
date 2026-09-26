#!/usr/bin/env node
/**
 * 框架版本号：根 package.json、packages/*、apps/seed、运行时的 RUNTIME_VERSION、
 * qqbot.manifest.json 的 core / ui 必须是同一个值（面板显示的是 RUNTIME_VERSION）。
 * plugins/* 各自有版本，不在此列。
 *
 *   node scripts/version.mjs              核对是否一致
 *   node scripts/version.mjs check v0.2.0 核对是否一致且等于给定版本（发版工作流用）
 *   node scripts/version.mjs set 0.2.0    全部改成给定版本
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const packageJsons = [
  'package.json',
  ...readdirSync(path.join(root, 'packages')).map((d) => `packages/${d}/package.json`),
  'apps/seed/package.json',
]

// 每一处：文件 + 匹配版本号的正则（第 1 组是版本号前面的部分）
const sites = [
  ...packageJsons.map((file) => ({ file, label: file, re: /^(\s*"version":\s*")[^"]+/m })),
  { file: 'packages/runtime/src/runtime.ts', label: 'RUNTIME_VERSION', re: /(export const RUNTIME_VERSION = ')[^']+/ },
  { file: 'apps/seed/qqbot.manifest.json', label: 'qqbot.manifest.json core', re: /("core":\s*\{\s*"version":\s*")[^"]+/ },
  { file: 'apps/seed/qqbot.manifest.json', label: 'qqbot.manifest.json ui', re: /("ui":\s*\{\s*"version":\s*")[^"]+/ },
]

function read(site) {
  const text = readFileSync(path.join(root, site.file), 'utf8')
  const m = text.match(site.re)
  if (!m) throw new Error(`${site.label}：找不到版本号`)
  return m[0].slice(m[1].length)
}

const [cmd = 'check', arg] = process.argv.slice(2)
const semver = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

if (cmd === 'set') {
  const version = arg?.replace(/^v/, '')
  if (!version || !semver.test(version)) {
    console.error('用法：node scripts/version.mjs set <x.y.z>')
    process.exit(1)
  }
  for (const site of sites) {
    const file = path.join(root, site.file)
    const text = readFileSync(file, 'utf8')
    writeFileSync(file, text.replace(site.re, `$1${version}`))
  }
  console.log(`已改为 ${version}：\n${sites.map((s) => `  ${s.label}`).join('\n')}`)
} else if (cmd === 'check') {
  const found = sites.map((site) => ({ label: site.label, version: read(site) }))
  const expected = arg?.replace(/^v/, '') ?? found[0].version
  const wrong = found.filter((f) => f.version !== expected)
  if (wrong.length) {
    console.error(`版本号不一致，应为 ${expected}：`)
    for (const f of wrong) console.error(`  ${f.label}: ${f.version}`)
    console.error('用 node scripts/version.mjs set <版本> 统一修改')
    process.exit(1)
  }
  console.log(`版本号一致：${expected}`)
} else {
  console.error(`不认识的命令：${cmd}`)
  process.exit(1)
}
