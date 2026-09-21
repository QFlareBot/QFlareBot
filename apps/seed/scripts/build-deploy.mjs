#!/usr/bin/env node
/**
 * 自部署脚本（源码优先模型，见 docs/design.md 与 seed README）：
 *
 *   prepare  拉取构建清单（MANIFEST_URL，失败回退仓库内置清单）→ 合并插件集
 *            → git: 源码按 commit 下载、esbuild 就地构建、校验声明清单 → 写 manifest.resolved.json
 *            → 调 qqbot-project 生成 dist/ 与 wrangler.generated.jsonc
 *   deploy   有 CLOUDFLARE_API_TOKEN 时走 Versions API：上传 → 预览地址健康检查 → 切流量；
 *            无凭证时退回 `wrangler deploy`（本地/CI 未注入凭证的场景）。
 *
 * 用法：
 *   node scripts/build-deploy.mjs prepare
 *   node scripts/build-deploy.mjs deploy
 */
import { execFileSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { buildPlugin } from '@qqbot/plugin-cli'
import { CloudflareApiError, CloudflareWorkersApi, computeIntegrity, createHttpFetcher, deploy, parseJsonc } from '@qqbot/projector'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUILD_PLUGINS_DIR = path.join(appDir, '.build-plugins')
const RESOLVED_MANIFEST = path.join(appDir, 'manifest.resolved.json')

const GIT_SOURCE = /^git:([^/\s]+)\/([^#\s@]+)@([0-9a-f]{7,40})(?:#([^#\s]+))?$/

function stableStringify(value) {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
}

/** 拉取 D1 插件集；失败（未配置 / 网络错误 / Worker 不可达）回退到仓库内置清单 */
async function fetchRemotePlugins() {
  const url = process.env.MANIFEST_URL
  if (!url) return null
  try {
    const headers = process.env.MANIFEST_TOKEN ? { authorization: `Bearer ${process.env.MANIFEST_TOKEN}` } : {}
    const res = await fetch(url, { headers })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (!Array.isArray(data.plugins)) throw new Error('响应缺少 plugins 数组')
    console.log(`已从构建清单接口取得 ${data.plugins.length} 个插件（hash ${String(data.hash).slice(0, 12)}…）`)
    return data.plugins
  } catch (err) {
    console.warn(`拉取构建清单失败（${err.message}），回退到仓库内置清单 qqbot.manifest.json`)
    return null
  }
}

/** 拉取线上 Worker 的基础设施绑定（KV/D1/R2 ID 及自定义域名）；失败则保持环境现状 */
async function fetchRemoteConfig() {
  const url = process.env.MANIFEST_URL
  if (!url) return null
  try {
    const configUrl = url.replace(/\/build-manifest(\?.*)?$/, '/build-config$1')
    const headers = process.env.MANIFEST_TOKEN ? { authorization: `Bearer ${process.env.MANIFEST_TOKEN}` } : {}
    const res = await fetch(configUrl, { headers })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (!data.bindings || typeof data.bindings !== 'object') throw new Error('响应缺少 bindings 对象')
    console.log('已从构建配置接口取得基础设施绑定标识：', data.bindings)
    return data.bindings
  } catch (err) {
    console.warn(`拉取基础设施配置未完成（${err.message}），使用本地/环境变量配置`)
    return null
  }
}

/** 下载 git:<owner>/<repo>@<sha> 的源码 tarball 并解包，返回插件目录 */
async function extractGitSource(name, source) {
  const match = GIT_SOURCE.exec(source)
  if (!match) throw new Error(`无法解析 git 源码来源：${source}`)
  const [, owner, repo, sha, subdir] = match
  const dest = path.join(BUILD_PLUGINS_DIR, `${name}-${sha}`)
  await rm(dest, { recursive: true, force: true })
  await mkdir(dest, { recursive: true })

  const tgz = path.join(os.tmpdir(), `qqbot-src-${name}-${sha}.tar.gz`)
  const res = await fetch(`https://codeload.github.com/${owner}/${repo}/tar.gz/${sha}`, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`下载 ${owner}/${repo}@${sha} 源码失败：HTTP ${res.status}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tgz))
  execFileSync('tar', ['xzf', tgz, '-C', dest])
  await rm(tgz, { force: true })

  const entries = await readdir(dest, { withFileTypes: true })
  const top = entries.filter((e) => e.isDirectory())
  if (top.length !== 1) throw new Error(`${owner}/${repo}@${sha} 的 tarball 结构异常：期望单个顶层目录`)
  const pluginDir = subdir ? path.join(dest, top[0].name, subdir) : path.join(dest, top[0].name)
  if (!path.resolve(pluginDir).startsWith(path.resolve(dest))) throw new Error(`非法的子目录：${subdir}`)
  return pluginDir
}

/** 就地构建 git: 来源的插件，校验声明清单，返回替换后的清单条目 */
async function buildGitPlugin(entry) {
  const pluginDir = await extractGitSource(entry.name, entry.source)
  let sdkEntry
  try {
    sdkEntry = fileURLToPath(import.meta.resolve('@qqbot/sdk'))
  } catch {}
  const { manifest, outFile } = await buildPlugin({
    cwd: pluginDir,
    ...(sdkEntry ? { alias: { '@qqbot/sdk': sdkEntry } } : {}),
  })

  if (manifest.name !== entry.name) {
    throw new Error(`${entry.name} 的源码声明 name 为 ${manifest.name}——插件源与安装记录不一致，请卸载后重装`)
  }
  for (const declaredPath of ['manifest.json', 'dist/manifest.json']) {
    let declared
    try {
      declared = JSON.parse(await readFile(path.join(pluginDir, declaredPath), 'utf8'))
    } catch {
      continue
    }
    if (stableStringify(declared) !== stableStringify(manifest)) {
      const fields = Object.keys({ ...manifest, ...declared }).filter(
        (k) => stableStringify(manifest[k]) !== stableStringify(declared[k]),
      )
      throw new Error(
        `${entry.name} 的声明清单与源码不一致（字段：${fields.join('、') || '整体'}）——请重新运行 qqbot-plugin build 并提交新的 manifest.json`,
      )
    }
    break
  }

  const code = await readFile(outFile, 'utf8')
  return {
    name: manifest.name,
    version: manifest.version,
    source: `file:${path.relative(appDir, outFile).split(path.sep).join('/')}`,
    integrity: await computeIntegrity(code),
    enabled: true,
    manifest,
  }
}

async function prepare() {
  const remoteConfig = await fetchRemoteConfig()
  if (remoteConfig) {
    if (remoteConfig.workerName && !process.env.CF_WORKER_NAME) process.env.CF_WORKER_NAME = remoteConfig.workerName
    if (remoteConfig.kvId && !process.env.CF_KV_ID) process.env.CF_KV_ID = remoteConfig.kvId
    if (remoteConfig.d1Id && !process.env.CF_D1_ID) process.env.CF_D1_ID = remoteConfig.d1Id
    if (remoteConfig.r2Name && !process.env.CF_R2_NAME) process.env.CF_R2_NAME = remoteConfig.r2Name
    if (remoteConfig.domain && !process.env.CF_CUSTOM_DOMAIN) process.env.CF_CUSTOM_DOMAIN = remoteConfig.domain
    if (remoteConfig.defaultDomain && !process.env.CF_DEFAULT_DOMAIN) process.env.CF_DEFAULT_DOMAIN = remoteConfig.defaultDomain
  }

  const base = JSON.parse(await readFile(path.join(appDir, 'qqbot.manifest.json'), 'utf8'))
  const remote = (await fetchRemotePlugins()) ?? []
  const overrides = new Map(remote.map((p) => [p.name, p]))
  const baseNames = new Set(base.plugins.map((p) => p.name))
  const merged = [
    ...base.plugins.map((p) => overrides.get(p.name) ?? p),
    ...remote.filter((p) => !baseNames.has(p.name)).sort((a, b) => a.name.localeCompare(b.name)),
  ]

  const plugins = []
  for (const entry of merged) {
    if (entry.source?.startsWith('git:')) {
      process.stdout.write(`构建插件 ${entry.name}（${entry.source}）…`)
      const built = await buildGitPlugin(entry)
      console.log(` 完成，版本 ${built.version}`)
      plugins.push(built)
    } else {
      plugins.push(entry)
    }
  }

  const resolved = { core: base.core, ...(base.ui ? { ui: base.ui } : {}), plugins }
  await writeFile(RESOLVED_MANIFEST, `${JSON.stringify(resolved, null, 2)}\n`)

  // dist 里可能残留上一次构建的插件模块，清掉再投影，deploy 阶段才敢按目录反推模块集
  await rm(path.join(appDir, 'dist'), { recursive: true, force: true })
  // package.json 的 bin 指向 dist/cli.js，与入口 dist/index.js 同目录
  const entryUrl = import.meta.resolve('@qqbot/projector')
  const cliJs = path.join(path.dirname(fileURLToPath(entryUrl)), 'cli.js')
  execFileSync(process.execPath, [cliJs, 'build', '--manifest', path.basename(RESOLVED_MANIFEST), '--wrangler', 'wrangler.jsonc', '--out', 'dist'], {
    cwd: appDir,
    stdio: 'inherit',
    env: process.env,
  })

  const { hash } = JSON.parse(await readFile(path.join(appDir, 'dist', 'projection.json'), 'utf8'))
  console.log(`清单解析完成，投影哈希 ${hash}`)
}

async function collectModules(dir, prefix = '') {
  const out = {}
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) Object.assign(out, await collectModules(path.join(dir, entry.name), rel))
    else if (entry.name.endsWith('.js')) out[rel] = await readFile(path.join(dir, entry.name), 'utf8')
  }
  return out
}

async function deployPhase() {
  const projection = JSON.parse(await readFile(path.join(appDir, 'dist', 'projection.json'), 'utf8'))
  const wrangler = parseJsonc(await readFile(path.join(appDir, 'wrangler.jsonc'), 'utf8'))
  const scriptName = process.env.CF_WORKER_NAME?.trim() || wrangler.name
  if (!scriptName) throw new Error('缺少 Worker 名称（环境变量 CF_WORKER_NAME 或 wrangler.jsonc 的 name）')

  const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID } = process.env
  let accountId = CLOUDFLARE_ACCOUNT_ID
  if (CLOUDFLARE_API_TOKEN && !accountId) {
    try {
      const res = await fetch('https://api.cloudflare.com/client/v4/accounts?per_page=10', {
        headers: { authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` },
      })
      const data = await res.json()
      const accounts = data?.result ?? []
      if (accounts.length === 1) {
        accountId = accounts[0].id
        console.log(`已自动推导单账户 ID：${accountId}`)
      }
    } catch {}
  }

  const isInitialBootstrap = process.env.INITIAL_BOOTSTRAP === 'true'
  if (isInitialBootstrap) {
    console.log('检测到引导首次部署（INITIAL_BOOTSTRAP），使用 wrangler deploy 进行资源初始化与域名/触发器绑定…')
    execFileSync('pnpm', ['exec', 'wrangler', 'deploy', '--config', 'wrangler.generated.jsonc'], {
      cwd: appDir,
      stdio: 'inherit',
      env: process.env,
    })
    return
  }

  if (!CLOUDFLARE_API_TOKEN || !accountId) {
    console.log('未检测到 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID，退回 wrangler deploy（无预览健康检查）')
    execFileSync('pnpm', ['exec', 'wrangler', 'deploy', '--config', 'wrangler.generated.jsonc'], {
      cwd: appDir,
      stdio: 'inherit',
      env: process.env,
    })
    return
  }

  // 直接用构建产物走 Versions API：上传 → 预览地址健康检查 → 切流量，健康检查失败不切
  const modules = await collectModules(path.join(appDir, 'dist'))
  const api = new CloudflareWorkersApi({ accountId, apiToken: CLOUDFLARE_API_TOKEN })
  try {
    await deploy({
      api,
      scriptName,
      projection: { mainModule: 'index.js', modules, hash: projection.hash, metadata: projection.metadata },
      onProgress: (step) => console.log(`[${step.stage}] ${step.message}`),
    })
  } catch (err) {
    const isScriptNotFound = err instanceof CloudflareApiError && err.errors?.some((e) => e.code === 10007)
    if (isScriptNotFound) {
      console.warn(`Worker ${scriptName} 尚未在 Cloudflare 创建，自动降级为 wrangler deploy 完成首次创建与配置绑定…`)
      execFileSync('pnpm', ['exec', 'wrangler', 'deploy', '--config', 'wrangler.generated.jsonc'], {
        cwd: appDir,
        stdio: 'inherit',
        env: process.env,
      })
      return
    }
    throw err
  }
}

const phase = process.argv[2]
if (phase === 'prepare') {
  await prepare()
} else if (phase === 'deploy') {
  await deployPhase()
} else {
  console.error('用法：node scripts/build-deploy.mjs <prepare|deploy>')
  process.exitCode = 1
}
