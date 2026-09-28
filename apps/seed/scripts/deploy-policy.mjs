/**
 * 自部署脚本里的判断逻辑，抽成纯函数。
 *
 * 这些分支决定「要不要继续部署」，错一个就是静默的生产事故（插件消失、部署到别人的
 * Worker、把未解析的绑定当新资源预配）。而 build-deploy.mjs 本体要跑真实的网络与
 * 子进程，测不动——所以判断留在这里，副作用留在那边。
 */

/**
 * 未解析的绑定：`unresolved` 才算，`skipped`（CF_*=none 显式跳过）不算。
 *
 * 例外是 KV：它是运行时必需的资源，不存在「跳过」——新投影器不会再给 KV 标 skipped，
 * 这里再兜一道，免得哪份旧产物把 `kv: 'skipped'` 带进来，让 wrangler 自动预配一个新 KV、快照失联。
 */
export function unresolvedBindings(projection) {
  if (!projection?.bindings) return null
  return Object.entries(projection.bindings)
    .filter(([name, state]) => state === 'unresolved' || (name === 'kv' && state !== 'resolved'))
    .map(([name]) => name.toUpperCase())
}

/** 绑定没解析出来时的报错：KV 缺了要额外说清楚它不能跳过 */
export function describeUnresolvedBindings(unresolved) {
  return [
    `基础设施绑定未解析：${unresolved.join('、')}。` +
      '拒绝部署——继续下去会把它们当成新资源自动预配，静默丢掉现有快照与插件数据。',
    ...(unresolved.includes('KV')
      ? ['KV 是运行时必需的资源（快照、插件配置都在里面），不能跳过：CF_KV_ID=none 不受支持，同样按没解析出来处理。']
      : []),
    '请确认 MANIFEST_URL 指向的 /admin/build-config 可达，且 Worker 上已写入 CF_KV_ID / CF_D1_ID / CF_R2_NAME。' +
      '若确实是想让 wrangler 自动预配全新资源，请改用 `pnpm --filter @qqbot/seed run deploy`。',
  ].join('\n')
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
 * Workers Builds 注入的「这次构建连着的那个 Worker」的名字。
 *
 * wrangler deploy 会拿它顶掉配置里的 name（日志里一句 "Failed to match Worker name… Overriding"），
 * 还会用 WRANGLER_CI_MATCH_TAG 核对目标 Worker 的 tag；Versions API 路径不看这两个变量，只认部署目标名。
 * 两者不一致时，同一次构建走哪条路就部署到哪个 Worker——必须当场说出来。
 */
export function ciOverrideName(env = process.env) {
  return env.WRANGLER_CI_OVERRIDE_NAME?.trim() || null
}

/** 部署目标名与 Workers Builds 连着的 Worker 名对不上时的醒目告警；一致或没有注入时为 null */
export function describeNameMismatch(scriptName, env = process.env) {
  const override = ciOverrideName(env)
  if (!override || override === scriptName) return null
  return [
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    `⚠️  部署目标名对不上：生成配置里是 ${scriptName}，Workers Builds 连着的 Worker 是 ${override}（WRANGLER_CI_OVERRIDE_NAME）`,
    `   Versions API 会部署到 ${scriptName}；降级为 wrangler deploy 时 wrangler 会改成部署到 ${override}。`,
    '   部署目标名依次取自构建环境变量 CF_WORKER_NAME、/admin/build-config 下发的 workerName（Worker 上的',
    '   CF_WORKER_NAME secret 或 vars.WORKER_NAME）、wrangler.jsonc 的 name。Worker 改过名、或同账号跑着两个',
    '   机器人时最容易这样——请把它改成这次构建所属的 Worker 名。',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
  ].join('\n')
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

/**
 * 子进程原样拿到的变量（名字不分大小写比对：Windows 上是 Path / SystemRoot 这种写法，代理变量两种大小写都有人用）。
 * 每一项都是「装依赖、跑 esbuild、执行插件入口」真正要用的：
 */
const ALLOWED_ENV_NAMES = new Set(
  [
    // 找得到 node / npm / pnpm；npm、pnpm 的缓存与 store 默认在 HOME 下（Workers Builds 缓存的就是这些默认位置）
    'PATH',
    'HOME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LANGUAGE',
    'TERM',
    'TZ',
    'NO_COLOR',
    'FORCE_COLOR',
    // npm / pnpm 看它关掉交互、进度条与更新提示
    'CI',
    'WORKERS_CI',
    'NODE_OPTIONS',
    'NODE_EXTRA_CA_CERTS',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'PNPM_HOME',
    // Workers Builds 用这两个挑 Node / pnpm 版本，版本管理器的垫片（shim）靠它们决定跑哪一版
    'NODE_VERSION',
    'PNPM_VERSION',
    // esbuild 的 JS 接口靠它找原生二进制（设了就必须传下去，否则找不到）
    'ESBUILD_BINARY_PATH',
    // Windows 本地跑时 Node 建 socket、npm 找全局目录要用
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'APPDATA',
    'LOCALAPPDATA',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
  ].map((n) => n.toUpperCase()),
)

/** 整组放行的前缀：区域设置、XDG 目录（pnpm 的 store / 缓存）、corepack 与 Node 版本管理器（asdf / mise / nvm / volta / fnm） */
const ALLOWED_ENV_PREFIX = /^(LC_|XDG_|COREPACK_|ASDF_|MISE_|NVM_|VOLTA_|FNM_)/i

/**
 * npm / pnpm 的「从哪装、怎么装」配置（`npm_config_<键>`，大小写都认）：源地址（含 `@scope:registry`）、
 * 证书、代理、缓存与 store 目录、重试与超时。只放这些键——认证类的（`_authToken`、`_auth`、`_password`、
 * `username`、客户端证书的 `key` / `cert`）一个都不放。
 */
const ALLOWED_NPM_CONFIG =
  /^npm_config_(registry|@[^:]+:registry|cafile|ca|strict_ssl|proxy|https_proxy|noproxy|no_proxy|cache|cache_dir|store_dir|state_dir|fetch_retries|fetch_retry_factor|fetch_retry_mintimeout|fetch_retry_maxtimeout|fetch_timeout|prefer_offline|maxsockets|network_concurrency|loglevel|progress|color|update_notifier|fund|audit)$/i

/** 放行规则之外再兜一道：名字里带这些词的，哪怕落在放行的前缀里（XDG_*、ASDF_* …）也不给 */
const SECRET_ENV_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|_PASS$|_PWD$|API_?KEY|_KEY$|PRIVATE|CREDENTIAL|AUTH|_DSN$|DATABASE_URL/i

function isAllowedEnvName(name) {
  if (SECRET_ENV_NAME.test(name)) return false
  return ALLOWED_ENV_NAMES.has(name.toUpperCase()) || ALLOWED_ENV_PREFIX.test(name) || ALLOWED_NPM_CONFIG.test(name)
}

/**
 * 给执行插件代码的子进程（装依赖、打包、抽清单）用的环境变量：**白名单**，只留上面列出的。
 *
 * 抽清单要在 Node 里执行插件入口，插件自己的代码、连同依赖的顶层代码都会跑；构建机上有拉清单的令牌与部署凭证，
 * 用户还可能在构建环境里放了别的（`OPENAI_API_KEY`、`DATABASE_URL`、`SENTRY_DSN`……）。以前是黑名单，
 * 名字起得不像凭证的就漏过去了——白名单漏的只会是「子进程少了个变量」，能在构建日志里看见、补上，
 * 而黑名单漏的是钥匙，看不见。这不是沙箱（文件系统照样碰得到），只是不把钥匙递过去。
 */
export function scrubbedEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined && isAllowedEnvName(k)))
}

/** 键排序后的 JSON：比较两份清单用，与字段顺序无关 */
export function stableStringify(value) {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
}

/** 「空默认值」：抽清单时框架给没写的字段补的那种（`[]`、`{}`、`false`、没有） */
function isEmptyDefault(value) {
  if (value === undefined || value === false) return true
  if (Array.isArray(value)) return value.length === 0
  if (value !== null && typeof value === 'object') return Object.keys(value).length === 0
  return false
}

/**
 * 仓库里提交的声明清单与构建时重新抽出来的清单是否一致。
 *
 * 声明清单是作者**当时**的 SDK 生成的，抽取用的是**机器人仓库**的 SDK（extractManifest），后者会给没写的
 * 字段补默认值（`apiVersion ?? API_VERSION`、后加的 `durableObjects: []`……）。逐字节比对的话，框架每加一个
 * 带默认值的字段、每升一次 API_VERSION，所有已装的 git 插件会在同一次构建里一起失败——
 * 违反「框架升级不要求插件重新打包」（docs/design.md 第 6 节）。所以只在顶层放宽：
 *
 * - 两边都有的字段必须一致（真改了命令、权限、DO 类都拦得住）；
 * - 只有一边有的字段，另一边的值是空默认值就算一致（旧清单缺 `durableObjects`，抽出来是 `[]`）；
 * - `apiVersion` 不拦：声明清单里的是插件最低要求的版本，安装时 Worker 已经检查过（validateManifest）。
 *   声明的比抽出来的低是常态（插件是用老 SDK 构建的），不必提；只有声明的更高才告警（机器人被降级过）。
 *
 * 嵌套字段仍逐字比对：里面的 `false` 不一定是默认值（命令的 `block` 默认是 true）。
 *
 * @returns {{ ok: boolean, fields: string[], warnings: string[] }} fields 是不一致的顶层字段
 */
export function compareDeclaredManifest(declared, extracted) {
  const fields = []
  const warnings = []
  const keys = [...new Set([...Object.keys(declared ?? {}), ...Object.keys(extracted ?? {})])].sort()
  for (const key of keys) {
    const a = declared?.[key]
    const b = extracted?.[key]
    if (stableStringify(a) === stableStringify(b)) continue
    if (key === 'apiVersion') {
      if (!(typeof a === 'number' && typeof b === 'number' && a < b)) {
        warnings.push(`声明清单的 apiVersion 是 ${a ?? '（没写）'}，按当前框架抽出来是 ${b ?? '（没写）'}——只告警，安装时已按声明清单检查过`)
      }
      continue
    }
    if (a === undefined && isEmptyDefault(b)) continue
    if (b === undefined && isEmptyDefault(a)) continue
    fields.push(key)
  }
  return { ok: fields.length === 0, fields, warnings }
}

/**
 * 构建环境自己的问题（下载源码、装依赖时网络出错，重试过了仍然不行），与插件本身无关。
 *
 * 要和插件自己的错误分开报：插件级的失败会经 build-report 记到 D1 条目上，面板随即建议卸载它——
 * codeload 抽风一次，就会让人去卸一个没问题的插件。这类错误改报成这次构建的整体错误（build-report 的 `error`）。
 */
export class TransientBuildError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'TransientBuildError'
  }
}

export function isTransientBuildError(err) {
  return err instanceof TransientBuildError || err?.name === 'TransientBuildError'
}

/** 值得重试的 HTTP 状态：超时、限流、服务端错误。404 之类是来源本身的问题（commit 不存在、私有仓库），重试没用 */
export function isTransientHttpStatus(status) {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599)
}

const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'ERR_STREAM_PREMATURE_CLOSE',
])

/** fetch / 流式写盘时抛出的网络类错误（含 AbortSignal.timeout 的超时）；沿 cause 链往下找错误码 */
export function isTransientFetchError(err) {
  for (let e = err, depth = 0; e && typeof e === 'object' && depth < 5; e = e.cause, depth++) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return true
    if (typeof e.code === 'string' && NETWORK_ERROR_CODES.has(e.code)) return true
    // undici 的网络失败统一是 TypeError('fetch failed')，具体原因在 cause 里，cause 缺席时也按网络问题算
    if (e.name === 'TypeError' && /fetch failed|network/i.test(String(e.message))) return true
  }
  return false
}

/**
 * npm / pnpm 输出里的网络类失败：连不上、超时、DNS、源站 5xx / 限流、下载被截断。
 * 完整性校验失败（EINTEGRITY）不算：那也可能是 lockfile 与源上的包真的对不上，是插件自己的问题。
 */
const TRANSIENT_INSTALL_OUTPUT =
  /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|EPIPE|ERR_SOCKET_TIMEOUT|socket hang up|E50[0-4]|E429|ERR_PNPM_FETCH_5\d\d|ERR_PNPM_FETCH_429|ERR_PNPM_META_FETCH_FAIL|ERR_PNPM_BAD_TARBALL_SIZE|network (request|error|timeout)|problem related to network connectivity)\b/i

/**
 * 装依赖失败是不是网络问题。
 *
 * @param {string} output 包管理器的输出
 * @param {{ timedOut?: boolean }} [opts] 整个安装超时被杀（慢到超时多半是网络，而不是插件写错了）
 */
export function isTransientInstallFailure(output, opts = {}) {
  if (opts.timedOut) return true
  return TRANSIENT_INSTALL_OUTPUT.test(String(output ?? ''))
}

/**
 * 构建环境的网络问题合成一条整体错误（报回面板时进 build-report 的 `error`，记到这次构建的账本上）。
 * 第一行要能单独看懂：服务端只取第一行当摘要。
 *
 * @param {Array<{ name: string, source: string, error: string }>} errors
 */
export function describeTransientFailures(errors) {
  return [
    `下载插件源码或依赖时网络出错（已重试），与插件本身无关，本次不部署、线上保持上一次成功的版本：${errors.map((e) => e.name).join('、')}`,
    ...errors.map((e) => `  - ${e.name}（${e.source}）：${e.error}`),
    '稍后重新触发构建即可；不要因为这个去卸载插件。',
  ].join('\n')
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
 * @param {{ reported?: boolean, phase?: 'prepare' | 'health' }} [opts] reported：失败原因是否已经报给了 Worker
 *   （线上是旧版本时报不上去）；phase：构建阶段失败，还是版本上传后预览健康检查里加载失败
 */
export function describePluginFailures(failures, opts = {}) {
  return [
    opts.phase === 'health'
      ? `${failures.length} 个插件在新版本的预览健康检查里加载失败，未切换流量，线上保持上一次成功的版本：`
      : `${failures.length} 个插件构建失败，本次不部署，线上保持上一次成功的版本：`,
    ...failures.map((f) => `  - ${f.name}（${f.source}）：${f.error}`),
    opts.reported
      ? '失败原因已回报给面板：到插件页「未上线的改动」里卸载或撤销它们，再重新构建。'
      : '到面板插件页「未上线的改动」里卸载或撤销它们（或用 DELETE /admin/manifest/plugins/<名字>），再重新构建。',
  ].join('\n')
}

/**
 * 健康检查报出的插件加载失败 → build-report 的 failures。
 *
 * source 必须是 D1 里记的原始来源（服务端只把错误记到 source 没变的那一条上），而 git 插件在构建机上
 * 已经被改写成本地产物路径了——取 prepare 写进 manifest.resolved.json 的出处（origin.source）。
 *
 * @param {Array<{ name: string, message: string }>} pluginErrors
 * @param {Array<{ name: string, source?: string, origin?: { source?: string } }>} plugins manifest.resolved.json 的 plugins
 */
export function healthFailures(pluginErrors, plugins = []) {
  const byName = new Map(plugins.map((p) => [p.name, p]))
  return pluginErrors.map((e) => {
    const p = byName.get(e.name)
    return { name: e.name, source: p?.origin?.source ?? p?.source ?? '', error: `预览版本里加载失败：${e.message}` }
  })
}

/**
 * Versions API 报错之后要不要降级。
 *
 * 只兜「这条路在当前环境走不通」的两种：10007 脚本不存在（首次创建）、401/403 凭证
 * 权限模型不同。其余一律上抛——尤其 SecretLossError 与 HealthCheckError 这两个安全阀，
 * 降级会把它们绕过去。
 *
 * 而且只看**上传那一步**的错误（deploy() 给错误标的 `stage`）：版本已经传上去之后，取子域、健康检查、
 * 切流量哪一步报 401/403 都不能降级——wrangler deploy 会绕过健康检查直接上线。没有 stage 的错误
 * （不是 deploy() 抛的）按旧规则处理。
 *
 * @returns {'script-not-found' | 'credentials' | 'rethrow'}
 */
export function classifyDeployError(err) {
  if (err?.stage !== undefined && err.stage !== 'upload') return 'rethrow'
  const errors = Array.isArray(err?.errors) ? err.errors : []
  if (err?.name === 'CloudflareApiError' && errors.some((e) => e?.code === 10007)) return 'script-not-found'
  if (err?.name === 'CloudflareApiError' && (err.status === 401 || err.status === 403)) return 'credentials'
  return 'rethrow'
}

/**
 * Versions API 失败之后怎么办：降级到 wrangler deploy、带着说明失败、还是原样上抛。
 *
 * 10007（脚本不存在）且部署目标名与 Workers Builds 连着的 Worker 名（WRANGLER_CI_OVERRIDE_NAME）对不上时
 * **不降级**：那不是「首次创建」，而是名字错了。降级的话 wrangler 会改用 CI 给的名字部署成功，
 * 以后每一次构建都静默走这条路、跳过健康检查；名字碰巧是同账号另一个机器人时，还会部署到它身上。
 *
 * @returns {{ action: 'wrangler', reason: string } | { action: 'fail', message: string } | { action: 'rethrow' }}
 */
export function planDeployFallback(err, scriptName, env = process.env) {
  const kind = classifyDeployError(err)
  if (kind === 'rethrow') return { action: 'rethrow' }
  const override = ciOverrideName(env)
  const mismatch = override && override !== scriptName
  if (kind === 'script-not-found') {
    if (mismatch) {
      return {
        action: 'fail',
        message:
          `部署目标 Worker ${scriptName} 不存在，而这次构建连着的 Worker 是 ${override}（WRANGLER_CI_OVERRIDE_NAME）——是名字对不上，不是首次创建。` +
          '不降级为 wrangler deploy：它会改用 CI 给的名字部署，以后每次都静默跳过健康检查。' +
          `请把 CF_WORKER_NAME（Worker secret 或构建环境变量）改成 ${override} 后重新构建。`,
      }
    }
    return { action: 'wrangler', reason: `Worker ${scriptName} 尚未在 Cloudflare 创建` }
  }
  const reason = `Versions API 拒绝了本次调用（HTTP ${err.status}：${err.message}）`
  return {
    action: 'wrangler',
    reason: mismatch ? `${reason}；注意 wrangler 会部署到 ${override}（WRANGLER_CI_OVERRIDE_NAME），不是 ${scriptName}` : reason,
  }
}
