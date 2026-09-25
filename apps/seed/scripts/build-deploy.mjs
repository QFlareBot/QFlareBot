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

/**
 * 拉取 D1 插件集。
 *
 * 失败不再静默吞掉——调用方要能区分「没配 MANIFEST_URL」「拉到了」「拉不到」三种情况，
 * 因为「拉不到」时继续构建会让 D1 里装的插件从 Worker 上悄悄消失。
 *
 * @returns {{ skipped: true } | { ok: true, plugins: unknown[], hash: string, pendingBuild: unknown } | { ok: false, error: string }}
 */
async function fetchRemoteManifest() {
  const url = process.env.MANIFEST_URL
  if (!url) return { skipped: true }
  try {
    const headers = process.env.MANIFEST_TOKEN ? { authorization: `Bearer ${process.env.MANIFEST_TOKEN}` } : {}
    const res = await fetch(url, { headers })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (!Array.isArray(data.plugins)) throw new Error('响应缺少 plugins 数组')
    console.log(`已从构建清单接口取得 ${data.plugins.length} 个插件（hash ${String(data.hash).slice(0, 12)}…）`)
    return { ok: true, plugins: data.plugins, hash: String(data.hash ?? ''), pendingBuild: data.pendingBuild ?? null }
  } catch (err) {
    return { ok: false, error: err.message }
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
  const remote = await fetchRemoteManifest()

  // 拉不到清单时默认**硬失败**：继续下去只会打包仓库内置清单，D1 里装的插件会从 Worker 上
  // 静默消失（数据还在 D1，插件不跑了），而构建却报成功——这是最难查的一类故障。
  // 唯一该容忍的情况是本次部署本来就没有 D1：那时 build-manifest 返回 503 是预期的，
  // 而「没有 D1」这件事由 build-config 的 d1Id === null 明确回答（拿不到这个答案就按"拉不到"处理）。
  if (!remote.ok && !remote.skipped) {
    // 只认 hasD1 —— 它由 Worker 侧的 `!!env.DB` 如实回答。早先这里看的是 `d1Id === null`，
    // 而 d1Id 来自 CF_D1_ID secret：secret 没写但 D1 确实绑着的部署会被误判成「没有 D1」，
    // 于是清单拉不到时静默放行，D1 里装的插件全部从 Worker 上消失。
    // 旧版 Worker 没有这个字段 → undefined → 不等于 false → 走硬失败，方向是安全的。
    if (remoteConfig?.hasD1 === false) {
      console.warn(`构建清单不可用（${remote.error}），但本次部署没有 D1，按"无 D1 插件集"继续`)
    } else if (process.env.MANIFEST_FALLBACK === '1') {
      console.warn(
        `⚠️ 拉取构建清单失败（${remote.error}），MANIFEST_FALLBACK=1 已显式接受回退到仓库内置清单——` +
          '本次构建不会包含 D1 里装的插件',
      )
    } else {
      throw new Error(
        `拉取构建清单失败（${remote.error}）：无法确认 D1 里装了哪些插件。\n` +
          '继续构建只会打包仓库内置清单，D1 里装的插件会从 Worker 上消失（数据还在，插件不跑了）。\n' +
          '请检查 MANIFEST_URL / MANIFEST_TOKEN 与面板可达性；确实要接受"只打包内置插件"，设 MANIFEST_FALLBACK=1 重跑。',
      )
    }
  }
  const remotePlugins = remote.ok ? remote.plugins : []

  // 触发时的清单与实际构建的清单不一致：只告警不失败。设计语义是「收敛到最新」，
  // 并发装两个插件时第二次构建必然会遇到这种情况，做成失败只会让正常操作无故炸掉。
  if (remote.ok && remote.pendingBuild && remote.pendingBuild.hash !== remote.hash) {
    console.warn(
      `⚠️ 触发构建时的清单哈希（${String(remote.pendingBuild.hash).slice(0, 12)}…，构建 ${remote.pendingBuild.buildUuid ?? '未知'}）` +
        `与本次实际构建的（${remote.hash.slice(0, 12)}…）不一致——触发之后清单又变过。` +
        '本次按最新清单构建；构建完成后请确认插件是否都到位。',
    )
  }

  const overrides = new Map(remotePlugins.map((p) => [p.name, p]))
  const baseNames = new Set(base.plugins.map((p) => p.name))
  const merged = [
    ...base.plugins.map((p) => overrides.get(p.name) ?? p),
    ...remotePlugins.filter((p) => !baseNames.has(p.name)).sort((a, b) => a.name.localeCompare(b.name)),
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

/**
 * 跑 wrangler deploy，并把它与 Versions API 的关键差异说清楚。
 *
 * Versions API 只上传代码与绑定，**不碰脚本级设置**；wrangler deploy 会把 routes、
 * workers_dev、triggers.crons 一并同步成配置文件里的样子。而这份配置是从环境变量拼出来的，
 * 少一个变量线上就掉一块——最典型的是 CF_CUSTOM_DOMAIN 没配时生成配置里没有 routes，
 * 线上绑着的自定义域名会被摘掉，QQ 回调地址随之失效，而构建还是报成功。
 * 这里不拦（拦了会让人连退路都没有），但必须让它在构建日志里显眼。
 */
function runWranglerDeploy(generated, reason) {
  console.warn(
    [
      '',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `⚠️  降级为 wrangler deploy：${reason}`,
      '   wrangler 会按生成配置同步脚本级设置，本次将把线上改成：',
      `     routes       ${generated.routes?.length ? generated.routes.map((r) => r.pattern).join('、') : '（无——线上若绑了自定义域名会被摘掉）'}`,
      `     workers_dev  ${generated.workers_dev ?? '（未声明，由 wrangler 决定）'}`,
      `     crons        ${generated.triggers?.crons?.join('、') ?? '（无）'}`,
      '   本次部署不经过预览地址健康检查，也不做 secret 保全校验。',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '',
    ].join('\n'),
  )
  execFileSync('pnpm', ['exec', 'wrangler', 'deploy', '--config', 'wrangler.generated.jsonc'], {
    cwd: appDir,
    stdio: 'inherit',
    env: process.env,
  })
}

async function deployPhase() {
  const projection = JSON.parse(await readFile(path.join(appDir, 'dist', 'projection.json'), 'utf8'))
  // 必须读 prepare 生成的配置而不是模板：CF_WORKER_NAME 只在 prepare 进程里被 /admin/build-config
  // 注入，而构建机的 build 与 deploy 是两条独立命令、两个进程，env 不传递。读模板会永远拿到
  // 模板里的默认名，把版本传到同名的另一个 Worker 上（同账号跑第二个 bot 时必然撞车）。
  const generated = parseJsonc(await readFile(path.join(appDir, 'wrangler.generated.jsonc'), 'utf8'))
  const scriptName = process.env.CF_WORKER_NAME?.trim() || generated.name
  if (!scriptName) throw new Error('缺少 Worker 名称（wrangler.generated.jsonc 的 name 或环境变量 CF_WORKER_NAME）')
  // 打出来：部署到哪个 Worker 是这一步最值得当场核对的事，错了会把版本传到同名的另一个 Worker 上
  console.log(`部署目标 Worker：${scriptName}`)

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

  // 未解析的绑定（仍是占位符）绝不能带进部署：Versions API 会把它当 id 上传，报一句看不懂的错；
  // 而 wrangler 回退会把它当成「新资源」自动预配——静默换掉 KV/D1，插件快照与数据当场失联。
  // 首次引导例外：那时资源由引导流程刚建好，走的正是 wrangler deploy 的资源创建语义。
  if (!isInitialBootstrap) {
    // 看投影记下的解析状态，不要去扫 metadata 里的占位符字符串：buildBindings 对 D1/R2 的处理
    // 是「是占位符就不 push」，没解析出来的绑定在 metadata 里是不出现而不是留个 <provisioned>，
    // 扫字符串只拦得住 KV，D1/R2 会被静默丢掉（版本上线后 env.DB 直接消失）。
    if (!projection.bindings) {
      throw new Error('dist/projection.json 缺少 bindings 解析状态，无法确认绑定是否齐全——请重新运行 prepare 后再部署')
    }
    const unresolved = Object.entries(projection.bindings)
      .filter(([, state]) => state === 'unresolved')
      .map(([name]) => name.toUpperCase())
    if (unresolved.length > 0) {
      throw new Error(
        `基础设施绑定未解析：${unresolved.join('、')}。` +
          '拒绝部署——继续下去会把它们当成新资源自动预配，静默丢掉现有快照与插件数据。' +
          '请确认 MANIFEST_URL 指向的 /admin/build-config 可达，且 Worker 上已写入 CF_KV_ID / CF_D1_ID / CF_R2_NAME。' +
          '若确实是想让 wrangler 自动预配全新资源，请改用 `pnpm --filter @qqbot/seed run deploy`。',
      )
    }
  }

  if (isInitialBootstrap) {
    // 引导首次部署本来就该走 wrangler：资源初始化、域名与 Cron 触发器都靠它落地，
    // 而域名此时由 CF_CUSTOM_DOMAIN 明确带进来，不存在「被摘掉」的情况。
    console.log('检测到引导首次部署（INITIAL_BOOTSTRAP），使用 wrangler deploy 进行资源初始化与域名/触发器绑定…')
    execFileSync('pnpm', ['exec', 'wrangler', 'deploy', '--config', 'wrangler.generated.jsonc'], {
      cwd: appDir,
      stdio: 'inherit',
      env: process.env,
    })
    return
  }

  if (!CLOUDFLARE_API_TOKEN || !accountId) {
    runWranglerDeploy(generated, '未检测到 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID')
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
    // 兜底只覆盖「这条路在当前环境走不通」的两种情况：
    //   10007 = 脚本还不存在（首次创建）；401/403 = 构建环境注入的凭证与主 token 权限模型不同。
    // 其余错误（含 SecretLossError / HealthCheckError 这两个安全阀）一律向上抛，不做兜底。
    const isScriptNotFound = err instanceof CloudflareApiError && err.errors?.some((e) => e.code === 10007)
    const isCredentialProblem = err instanceof CloudflareApiError && (err.status === 401 || err.status === 403)
    if (isScriptNotFound || isCredentialProblem) {
      runWranglerDeploy(
        generated,
        isScriptNotFound
          ? `Worker ${scriptName} 尚未在 Cloudflare 创建`
          : `Versions API 拒绝了本次调用（HTTP ${err.status}：${err.message}）`,
      )
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
