/**
 * 自部署脚本里的判断逻辑，抽成纯函数。
 *
 * 这些分支决定「要不要继续部署」，错一个就是静默的生产事故（插件消失、部署到别人的
 * Worker、把未解析的绑定当新资源预配）。而 build-deploy.mjs 本体要跑真实的网络与
 * 子进程，测不动——所以判断留在这里，副作用留在那边。
 */

/** 未解析的绑定：`unresolved` 才算，`skipped`（CF_*=none 显式跳过）不算 */
export function unresolvedBindings(projection) {
  if (!projection?.bindings) return null
  return Object.entries(projection.bindings)
    .filter(([, state]) => state === 'unresolved')
    .map(([name]) => name.toUpperCase())
}

/**
 * `/admin/build-config` 的回答 → 本进程要补的环境变量。只补缺，构建环境里显式设置的优先。
 *
 * `hasD1` / `hasR2` 为假时补 `none` 哨兵。CF_* 缺失分不清「资源没绑」与「绑着但 secret 没写」，
 * 投影只能照「没解析出来」处理，部署护栏随即拒绝——R2 未激活降级、D1 选了 none 的部署
 * 会因此**每一次**构建都被拒。判据同 manifestPolicy：只信 Worker 侧 `!!env.X` 的如实回答，
 * 旧版 Worker 没有这两个字段 → undefined → 不补，照旧交给护栏，方向是安全的。
 */
export function envFromRemoteConfig(remoteConfig, env = process.env) {
  if (!remoteConfig) return {}
  const out = {}
  const fill = (name, value) => {
    if (value && !env[name]) out[name] = value
  }
  fill('CF_WORKER_NAME', remoteConfig.workerName)
  fill('CF_KV_ID', remoteConfig.kvId)
  fill('CF_D1_ID', remoteConfig.d1Id || (remoteConfig.hasD1 === false ? 'none' : undefined))
  fill('CF_R2_NAME', remoteConfig.r2Name || (remoteConfig.hasR2 === false ? 'none' : undefined))
  fill('CF_DEFAULT_DOMAIN', remoteConfig.defaultDomain)
  return out
}

/**
 * 拉不到构建清单时该怎么办。
 *
 * 默认硬失败：继续构建只会打包仓库内置清单，D1 里装的插件会从 Worker 上静默消失
 * （数据还在，插件不跑了），而构建报成功——最难查的一类故障。
 *
 * @returns {'use-remote' | 'skip' | 'no-d1' | 'forced-fallback' | 'fail'}
 */
export function manifestPolicy(remote, remoteConfig, env = process.env) {
  if (remote.skipped) return 'skip'
  if (remote.ok) return 'use-remote'
  // 判据只能是 hasD1（Worker 侧 `!!env.DB` 如实回答）。早先看的是 `d1Id === null`，
  // 而 d1Id 来自 CF_D1_ID secret：secret 没写但 D1 确实绑着的部署会被误判成「没有 D1」。
  // 旧版 Worker 没有 hasD1 字段 → undefined → 不等于 false → 落到硬失败，方向是安全的。
  if (remoteConfig?.hasD1 === false) return 'no-d1'
  if (env.MANIFEST_FALLBACK === '1') return 'forced-fallback'
  return 'fail'
}

/**
 * 部署目标 Worker 名。
 *
 * 必须取 prepare 生成的配置而不是模板：CF_WORKER_NAME 只在 prepare 进程里被
 * /admin/build-config 注入，而构建机的 build 与 deploy 是两条独立命令、两个进程。
 */
export function resolveScriptName(generated, env = process.env) {
  return env.CF_WORKER_NAME?.trim() || generated?.name || null
}

/**
 * 回报失败原因的地址：与 build-config 一样从 MANIFEST_URL 推出来（…/build-manifest → …/build-report）。
 * 推不出来（MANIFEST_URL 不是 build-manifest 结尾）就不报——报到别处去比不报更糟。
 */
export function buildReportUrl(manifestUrl) {
  if (typeof manifestUrl !== 'string') return null
  const m = /^(.*)\/build-manifest(\?.*)?$/.exec(manifestUrl.trim())
  return m ? `${m[1]}/build-report${m[2] ?? ''}` : null
}

/**
 * 插件的出处，随部署清单进投影、再进运行时：D1 清单里有这个名字就是面板装的（D1 同名覆盖内置），
 * 否则是仓库内置的。source 留改写成本地产物路径之前的原始来源。
 *
 * @param {{ name: string, source: string }} entry
 * @param {{ has(name: string): boolean }} remoteNames D1 清单里的插件名
 */
export function originOf(entry, remoteNames) {
  return { from: remoteNames.has(entry.name) ? 'd1' : 'repo', source: entry.source }
}

/** 框架自己的包：构建时一律用机器人仓库那一份（@qqbot/sdk 经 alias），不能从 npm 装进插件 */
function isFrameworkPackage(name) {
  return name.startsWith('@qqbot/')
}

/**
 * 插件的依赖怎么装。
 *
 * - 没有第三方依赖（只写了 @qqbot/sdk 也算）：跳过，和以前完全一样；
 * - 有依赖就必须提交 lockfile：没有 lockfile，同一个 commit 在不同时间会装出不同的代码，
 *   而每装一个别的插件都会重建全部插件，这个插件的代码就可能被悄悄换掉，「钉在 commit 上」形同虚设；
 * - 只装 dependencies（不装 devDependencies：插件把 SDK、CLI 写成 file:../ 本地路径很常见，构建机上不存在），
 *   不跑安装脚本（构建机上有凭证）。
 *
 * @param {{ dependencies?: Record<string, string>, packageManager?: string } | null} pkg 插件的 package.json
 * @param {Set<string>} files 插件目录里的文件名
 * @returns {{ action: 'skip' } | { action: 'error', message: string } |
 *   { action: 'install', manager: 'npm' | 'pnpm', command: string, args: string[], packages: string[] }}
 */
export function planDependencyInstall(pkg, files) {
  const names = Object.keys(pkg?.dependencies ?? {})
  const packages = names.filter((n) => !isFrameworkPackage(n))
  if (packages.length === 0) return { action: 'skip' }

  const framework = names.filter(isFrameworkPackage)
  if (framework.length > 0) {
    return {
      action: 'error',
      message: `dependencies 里的 ${framework.join('、')} 请移到 devDependencies：框架包构建时一律用机器人仓库那一份，不能从 npm 装进插件`,
    }
  }

  const hasNpmLock = files.has('package-lock.json') || files.has('npm-shrinkwrap.json')
  const hasPnpmLock = files.has('pnpm-lock.yaml')
  // 两种 lockfile 都在时听 packageManager 的；都没写就用 npm（随 Node 自带，最不容易出岔子）
  const prefersPnpm = typeof pkg?.packageManager === 'string' && pkg.packageManager.startsWith('pnpm')
  const npm = { action: 'install', manager: 'npm', command: 'npm', args: ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], packages }
  const pnpm = { action: 'install', manager: 'pnpm', command: 'pnpm', args: ['install', '--frozen-lockfile', '--prod', '--ignore-scripts'], packages }
  if (hasPnpmLock && (prefersPnpm || !hasNpmLock)) return pnpm
  if (hasNpmLock) return npm

  if (files.has('yarn.lock') || files.has('bun.lock') || files.has('bun.lockb')) {
    return { action: 'error', message: '插件依赖目前只支持 npm（package-lock.json）与 pnpm（pnpm-lock.yaml）的 lockfile' }
  }
  return {
    action: 'error',
    message:
      `有 dependencies（${packages.join('、')}）但没有提交 lockfile：请把 package-lock.json 或 pnpm-lock.yaml 一起提交——` +
      '没有 lockfile，同一个 commit 在不同时间会装出不同的代码',
  }
}

/** 像凭证的环境变量：名字里带这些词的，或者属于构建机凭证那几组 */
const SECRET_ENV_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE|CREDENTIAL|AUTH/i
const SECRET_ENV_PREFIX = /^(CF_|CLOUDFLARE_|MANIFEST_)/

/**
 * 去掉凭证的环境变量，给执行插件代码的子进程用。
 *
 * 抽清单要在 Node 里执行插件入口，插件自己的代码、连同依赖的顶层代码都会跑；构建机上有拉清单的令牌，
 * 部署还要用部署凭证。别让它们顺手读到。这不是沙箱（文件系统照样碰得到），只是不把钥匙递过去。
 */
export function scrubbedEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !SECRET_ENV_NAME.test(k) && !SECRET_ENV_PREFIX.test(k)))
}

/** 包管理器报错时，截最后几行非空输出放进错误信息（会报回面板） */
export function tailLines(text, count = 12) {
  return String(text ?? '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(-count)
    .join('\n')
}

/**
 * 构建插件时的报错补一句人话。最常见的是「找不到包」：构建机只装插件自己声明的依赖，
 * 而且在机器人仓库外面构建——以前碰巧能用上机器人仓库里装着的包，现在用不上了。
 */
export function explainBuildError(message) {
  const missing = [...String(message).matchAll(/Could not resolve "([^"]+)"/g)].map((m) => m[1])
  if (missing.length === 0) return message
  const unique = [...new Set(missing)]
  return (
    `${message}\n——找不到 ${unique.join('、')}：插件用到的第三方包要写进它自己 package.json 的 dependencies，并提交 lockfile。` +
    '构建机只安装插件自己声明的依赖（Node 内置模块如 fs、net 在 Workers 里不可用）'
  )
}

/**
 * 逐个插件的构建失败合成一条错误：构建日志最后一屏看的就是它。
 * 构建失败时线上保持上一次成功的版本（故意的），所以要说清楚接下来怎么办。
 *
 * @param {Array<{ name: string, source: string, error: string }>} failures
 * @param {{ reported?: boolean }} [opts] 失败原因是否已经报给了 Worker（线上是旧版本时报不上去）
 */
export function describePluginFailures(failures, opts = {}) {
  return [
    `${failures.length} 个插件构建失败，本次不部署，线上保持上一次成功的版本：`,
    ...failures.map((f) => `  - ${f.name}（${f.source}）：${f.error}`),
    opts.reported
      ? '失败原因已回报给面板：到插件页「未上线的改动」里卸载或撤销它们，再重新构建。'
      : '到面板插件页「未上线的改动」里卸载或撤销它们（或用 DELETE /admin/manifest/plugins/<名字>），再重新构建。',
  ].join('\n')
}

/**
 * Versions API 报错之后要不要降级。
 *
 * 只兜「这条路在当前环境走不通」的两种：10007 脚本不存在（首次创建）、401/403 凭证
 * 权限模型不同。其余一律上抛——尤其 SecretLossError 与 HealthCheckError 这两个安全阀，
 * 降级会把它们绕过去。
 *
 * @returns {'script-not-found' | 'credentials' | 'rethrow'}
 */
export function classifyDeployError(err) {
  const errors = Array.isArray(err?.errors) ? err.errors : []
  if (err?.name === 'CloudflareApiError' && errors.some((e) => e?.code === 10007)) return 'script-not-found'
  if (err?.name === 'CloudflareApiError' && (err.status === 401 || err.status === 403)) return 'credentials'
  return 'rethrow'
}
