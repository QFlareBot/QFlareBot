import { describe, expect, it } from 'vitest'
import {
  TransientBuildError,
  buildReportUrl,
  ciOverrideName,
  classifyDeployError,
  compareDeclaredManifest,
  describeNameMismatch,
  describePluginFailures,
  describeTransientFailures,
  describeUnresolvedBindings,
  envFromRemoteConfig,
  explainBuildError,
  healthFailures,
  isTransientBuildError,
  isTransientFetchError,
  isTransientHttpStatus,
  isTransientInstallFailure,
  manifestPolicy,
  originOf,
  planDependencyInstall,
  planDeployFallback,
  resolveScriptName,
  scrubbedEnv,
  tailLines,
  unresolvedBindings,
} from './deploy-policy.mjs'

describe('planDependencyInstall', () => {
  const files = (...names) => new Set(['package.json', 'src', ...names])

  it('没有第三方依赖就跳过——零依赖插件的构建与以前完全一样', () => {
    expect(planDependencyInstall({ devDependencies: { '@qqbot/sdk': 'file:../qqbot-workers/packages/sdk' } }, files())).toEqual({ action: 'skip' })
    expect(planDependencyInstall({}, files())).toEqual({ action: 'skip' })
    expect(planDependencyInstall(null, files())).toEqual({ action: 'skip' })
    // 把 SDK 误写进 dependencies 也照旧：它本来就不从 npm 装
    expect(planDependencyInstall({ dependencies: { '@qqbot/sdk': '^0.1.0' } }, files())).toEqual({ action: 'skip' })
  })

  it('按 lockfile 选包管理器：只装 dependencies、不跑安装脚本', () => {
    const pkg = { dependencies: { nanoid: '^5.0.0' } }
    expect(planDependencyInstall(pkg, files('package-lock.json'))).toEqual({
      action: 'install',
      manager: 'npm',
      command: 'npm',
      args: ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
      packages: ['nanoid'],
    })
    expect(planDependencyInstall(pkg, files('pnpm-lock.yaml'))).toMatchObject({
      manager: 'pnpm',
      args: ['install', '--frozen-lockfile', '--prod', '--ignore-scripts'],
    })
  })

  it('两种 lockfile 都在时听 packageManager 的，没写就用 npm', () => {
    const both = files('package-lock.json', 'pnpm-lock.yaml')
    expect(planDependencyInstall({ dependencies: { a: '1' } }, both)).toMatchObject({ manager: 'npm' })
    expect(planDependencyInstall({ dependencies: { a: '1' }, packageManager: 'pnpm@10.0.0' }, both)).toMatchObject({ manager: 'pnpm' })
  })

  it('有依赖却没 lockfile：失败并说清为什么非要不可', () => {
    const plan = planDependencyInstall({ dependencies: { nanoid: '^5.0.0' } }, files())
    expect(plan.action).toBe('error')
    expect(plan.message).toContain('没有提交 lockfile')
    expect(plan.message).toContain('nanoid')
  })

  it('yarn / bun 的 lockfile 暂不支持', () => {
    expect(planDependencyInstall({ dependencies: { a: '1' } }, files('yarn.lock'))).toMatchObject({ action: 'error' })
    expect(planDependencyInstall({ dependencies: { a: '1' } }, files('bun.lock'))).toMatchObject({ action: 'error' })
  })

  it('有真依赖、又把框架包写进了 dependencies：装不了（npm 上没有它），提示挪到 devDependencies', () => {
    const plan = planDependencyInstall({ dependencies: { nanoid: '^5.0.0', '@qqbot/sdk': '^0.1.0' } }, files('package-lock.json'))
    expect(plan).toMatchObject({ action: 'error' })
    expect(plan.message).toContain('@qqbot/sdk 请移到 devDependencies')
  })
})

describe('scrubbedEnv', () => {
  it('去掉凭证，留下 PATH、HOME 与 CI 标识', () => {
    const env = {
      PATH: '/usr/bin',
      HOME: '/root',
      CI: 'true',
      WORKERS_CI: '1',
      WORKERS_CI_BUILD_UUID: 'b-1',
      MANIFEST_URL: 'https://x/admin/build-manifest',
      MANIFEST_TOKEN: 't',
      CLOUDFLARE_API_TOKEN: 't',
      CLOUDFLARE_ACCOUNT_ID: 'a',
      CF_D1_ID: 'd',
      NPM_TOKEN: 't',
      npm_config__authToken: 't',
      GITHUB_TOKEN: 't',
      SOME_API_KEY: 'k',
    }
    expect(scrubbedEnv(env)).toEqual({ PATH: '/usr/bin', HOME: '/root', CI: 'true', WORKERS_CI: '1' })
  })

  // 回归：以前是黑名单，名字起得不像凭证的都漏过去了——而这个子进程会执行插件代码
  it('白名单：黑名单时代漏掉的这些一个都不给', () => {
    const env = {
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'sk-x',
      ANTHROPIC_KEY: 'k',
      STRIPE_SECRET_KEY: 'k',
      SSH_KEY: 'k',
      SMTP_PASS: 'p',
      DB_PWD: 'p',
      MYSQL_PASSWORD: 'p',
      DATABASE_URL: 'postgres://u:p@h/db',
      SENTRY_DSN: 'https://k@sentry.io/1',
      REDIS_URL: 'redis://:p@h',
      AWS_ACCESS_KEY_ID: 'a',
      AWS_SECRET_ACCESS_KEY: 's',
      WEBHOOK_SIGNING: 's',
      WORKERS_CI_COMMIT_SHA: 'abc',
      npm_config_user_agent: 'pnpm/10',
      npm_package_name: '@qqbot/seed',
    }
    expect(scrubbedEnv(env)).toEqual({ PATH: '/usr/bin' })
  })

  it('装依赖、打包真正要用的都在：临时目录、区域设置、代理（大小写两种）、证书、版本管理器、XDG', () => {
    const env = {
      PATH: '/usr/bin',
      HOME: '/root',
      TMPDIR: '/tmp',
      TMP: '/tmp',
      TEMP: '/tmp',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      TERM: 'xterm',
      NODE_OPTIONS: '--max-old-space-size=4096',
      NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
      HTTP_PROXY: 'http://p:3128',
      https_proxy: 'http://p:3128',
      no_proxy: 'localhost',
      NO_PROXY: 'localhost',
      COREPACK_HOME: '/root/.cache/corepack',
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
      PNPM_HOME: '/root/.local/share/pnpm',
      XDG_CACHE_HOME: '/root/.cache',
      XDG_DATA_HOME: '/root/.local/share',
      ASDF_DATA_DIR: '/opt/asdf',
      MISE_DATA_DIR: '/opt/mise',
      NODE_VERSION: '22',
      ESBUILD_BINARY_PATH: '/opt/esbuild',
      // Windows 上的写法
      Path: 'C:\\Windows',
      SystemRoot: 'C:\\Windows',
    }
    expect(scrubbedEnv(env)).toEqual(env)
  })

  it('npm 源配置放行，认证类的一个不放', () => {
    const env = {
      npm_config_registry: 'https://registry.npmmirror.com/',
      NPM_CONFIG_REGISTRY: 'https://registry.npmmirror.com/',
      'npm_config_@acme:registry': 'https://npm.acme.dev/',
      npm_config_cafile: '/etc/ca.pem',
      npm_config_store_dir: '/root/.pnpm-store',
      npm_config_cache: '/root/.npm',
      npm_config_fetch_retries: '5',
      npm_config__authToken: 't',
      'npm_config_//registry.npmjs.org/:_authToken': 't',
      npm_config__auth: 'dXNlcjpwYXNz',
      npm_config__password: 'p',
      npm_config_username: 'u',
      npm_config_key: '-----BEGIN PRIVATE KEY-----',
      npm_config_cert: '-----BEGIN CERTIFICATE-----',
      npm_config_email: 'a@b.c',
    }
    expect(Object.keys(scrubbedEnv(env)).sort()).toEqual(
      [
        'npm_config_registry',
        'NPM_CONFIG_REGISTRY',
        'npm_config_@acme:registry',
        'npm_config_cafile',
        'npm_config_store_dir',
        'npm_config_cache',
        'npm_config_fetch_retries',
      ].sort(),
    )
  })

  it('放行的前缀里名字像凭证的照样去掉', () => {
    expect(scrubbedEnv({ XDG_SECRET: 's', ASDF_TOKEN: 't', COREPACK_NPM_TOKEN: 't', MISE_GITHUB_TOKEN: 't', XDG_CONFIG_HOME: '/c' })).toEqual({
      XDG_CONFIG_HOME: '/c',
    })
  })
})

describe('compareDeclaredManifest', () => {
  /** 与 sdk extractManifest 同形的清单 */
  const extracted = (overrides = {}) => ({
    name: 'weather',
    version: '1.0.0',
    apiVersion: 1,
    permissions: [],
    depends: {},
    conflicts: [],
    commands: [{ name: '天气', description: '查天气' }],
    regex: [],
    events: [],
    buttons: [],
    cron: [],
    routes: [],
    hasMiddleware: false,
    services: [],
    durableObjects: [],
    ...overrides,
  })

  it('完全一致', () => {
    expect(compareDeclaredManifest(extracted(), extracted())).toEqual({ ok: true, fields: [], warnings: [] })
  })

  // 回归：9/25 抽清单时新加了 durableObjects: []，之前生成的声明清单没有这个字段，逐字节比对会让它们全部构建失败
  it('旧声明清单缺 durableObjects（和别的后加的带默认值字段）：按空默认值算一致', () => {
    const declared = extracted()
    delete declared.durableObjects
    delete declared.buttons
    delete declared.hasMiddleware
    delete declared.depends
    expect(compareDeclaredManifest(declared, extracted())).toMatchObject({ ok: true, fields: [] })
  })

  it('真的改了命令：仍然失败，并指出字段', () => {
    const declared = extracted()
    const changed = extracted({ commands: [{ name: '天气', description: '查天气' }, { name: '预报' }] })
    expect(compareDeclaredManifest(declared, changed)).toMatchObject({ ok: false, fields: ['commands'] })
  })

  it('声明清单缺的字段，抽出来却不是空默认值：失败（新加了 DO 类、开了中间件、加了服务）', () => {
    const declared = extracted()
    delete declared.durableObjects
    delete declared.hasMiddleware
    delete declared.services
    const result = compareDeclaredManifest(declared, extracted({ durableObjects: ['Room'], hasMiddleware: true, services: ['geo'] }))
    expect(result.ok).toBe(false)
    expect(result.fields).toEqual(['durableObjects', 'hasMiddleware', 'services'])
  })

  it('声明清单写了、抽出来没有的字段：非空就失败（displayName 被删了）', () => {
    const declared = extracted({ displayName: '天气' })
    expect(compareDeclaredManifest(declared, extracted())).toMatchObject({ ok: false, fields: ['displayName'] })
  })

  it('apiVersion 不一致只告警不失败——安装时 Worker 已按声明清单检查过', () => {
    const result = compareDeclaredManifest(extracted({ apiVersion: 1 }), extracted({ apiVersion: 2 }))
    expect(result.ok).toBe(true)
    expect(result.warnings).toEqual([expect.stringContaining('apiVersion')])
  })

  it('嵌套字段仍逐字比对：命令里的 false 不一定是默认值', () => {
    const declared = extracted({ commands: [{ name: '天气' }] })
    expect(compareDeclaredManifest(declared, extracted({ commands: [{ name: '天气', block: false }] }))).toMatchObject({ ok: false })
  })

  it('字段顺序不同不算不一致', () => {
    const declared = Object.fromEntries(Object.entries(extracted()).reverse())
    expect(compareDeclaredManifest(declared, extracted()).ok).toBe(true)
  })
})

describe('网络类错误', () => {
  it('值得重试的 HTTP 状态：5xx、429、408；404 不重试（commit 不存在、私有仓库是插件自己的问题）', () => {
    for (const s of [500, 502, 503, 504, 429, 408]) expect(isTransientHttpStatus(s)).toBe(true)
    for (const s of [400, 401, 403, 404, 410]) expect(isTransientHttpStatus(s)).toBe(false)
  })

  it('fetch 的网络错误与超时：沿 cause 找错误码', () => {
    const fetchFailed = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' }) })
    expect(isTransientFetchError(fetchFailed)).toBe(true)
    expect(isTransientFetchError(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))).toBe(true)
    expect(isTransientFetchError(Object.assign(new Error('socket'), { code: 'ECONNRESET' }))).toBe(true)
    expect(isTransientFetchError(new Error('下载 a/b@c 源码失败：HTTP 404'))).toBe(false)
    expect(isTransientFetchError(new Error('tar: Unexpected EOF'))).toBe(false)
    expect(isTransientFetchError(undefined)).toBe(false)
  })

  it('装依赖的输出：连不上源、源站 5xx、超时算网络问题；包不存在、lockfile 对不上不算', () => {
    expect(isTransientInstallFailure('npm error code ECONNRESET\nnpm error network aborted')).toBe(true)
    expect(isTransientInstallFailure('npm error code E503\nnpm error 503 Service Unavailable - GET https://registry.npmjs.org/nanoid')).toBe(true)
    expect(isTransientInstallFailure('ERR_PNPM_META_FETCH_FAIL  GET https://registry.npmjs.org/nanoid: request to ... failed, reason: ETIMEDOUT')).toBe(true)
    expect(isTransientInstallFailure('npm error network request to https://registry.npmjs.org/a failed')).toBe(true)
    expect(isTransientInstallFailure('', { timedOut: true })).toBe(true)
    expect(isTransientInstallFailure('npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/nope')).toBe(false)
    expect(isTransientInstallFailure('npm error code EUSAGE\nnpm ci can only install packages when your package.json and package-lock.json are in sync')).toBe(false)
    expect(isTransientInstallFailure('npm error code EINTEGRITY')).toBe(false)
    expect(isTransientInstallFailure('ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile"')).toBe(false)
  })

  it('TransientBuildError 认得出（名字对也算：跨模块边界时 instanceof 靠不住）', () => {
    expect(isTransientBuildError(new TransientBuildError('x'))).toBe(true)
    expect(isTransientBuildError(Object.assign(new Error('x'), { name: 'TransientBuildError' }))).toBe(true)
    expect(isTransientBuildError(new Error('x'))).toBe(false)
  })

  it('整体错误的第一行能单独看懂（服务端只取第一行当摘要），并说清不要去卸载插件', () => {
    const text = describeTransientFailures([
      { name: 'weather', source: 'git:me/weather@a1b2c3d4', error: '下载 me/weather@a1b2c3d4 源码失败（已试 3 次）：HTTP 502' },
    ])
    const [first] = text.split('\n')
    expect(first).toContain('网络出错')
    expect(first).toContain('与插件本身无关')
    expect(first).toContain('weather')
    expect(text).toContain('HTTP 502')
    expect(text).toContain('不要因为这个去卸载插件')
  })
})

describe('tailLines / explainBuildError', () => {
  it('只留最后几行非空输出', () => {
    expect(tailLines('a\n\nb\nc\n', 2)).toBe('b\nc')
  })

  it('找不到包时补一句：要写进插件自己的 dependencies', () => {
    const text = explainBuildError('Build failed with 1 error:\nsrc/index.ts:2:21: ERROR: Could not resolve "uqr"')
    expect(text).toContain('找不到 uqr')
    expect(text).toContain('dependencies')
    expect(explainBuildError('别的错误')).toBe('别的错误')
  })
})

describe('buildReportUrl', () => {
  it('从 MANIFEST_URL 推出回报地址，查询串原样保留', () => {
    expect(buildReportUrl('https://bot.example.workers.dev/admin/build-manifest')).toBe('https://bot.example.workers.dev/admin/build-report')
    expect(buildReportUrl('https://bot.example/admin/build-manifest?x=1')).toBe('https://bot.example/admin/build-report?x=1')
  })

  it('推不出来就不报：没配、或者不是 build-manifest 结尾', () => {
    expect(buildReportUrl(undefined)).toBeNull()
    expect(buildReportUrl('https://bot.example/some/other')).toBeNull()
  })
})

describe('originOf', () => {
  it('D1 清单里有这个名字就是面板装的，source 留原始来源', () => {
    const remote = new Set(['weather'])
    expect(originOf({ name: 'weather', source: 'git:me/weather@a1b2c3d4' }, remote)).toEqual({ from: 'd1', source: 'git:me/weather@a1b2c3d4' })
    expect(originOf({ name: 'echo', source: 'file:../../plugins/echo/dist/plugin.js' }, remote)).toEqual({
      from: 'repo',
      source: 'file:../../plugins/echo/dist/plugin.js',
    })
  })
})

describe('describePluginFailures', () => {
  it('逐个列出失败的插件，并说明线上保持原样', () => {
    const text = describePluginFailures([
      { name: 'a', source: 'git:me/a@a1b2c3d4', error: '声明清单与源码不一致' },
      { name: 'b', source: 'git:me/b@b2c3d4e5', error: '下载源码失败：HTTP 404' },
    ])
    expect(text).toContain('2 个插件构建失败')
    expect(text).toContain('线上保持上一次成功的版本')
    expect(text).toContain('  - a（git:me/a@a1b2c3d4）：声明清单与源码不一致')
    expect(text).toContain('  - b（git:me/b@b2c3d4e5）：下载源码失败：HTTP 404')
  })

  it('报没报上去说法不同：报不上去（线上是旧版本）时不能说「已回报」', () => {
    const failures = [{ name: 'a', source: 'git:me/a@a1b2c3d4', error: 'x' }]
    expect(describePluginFailures(failures, { reported: true })).toContain('已回报给面板')
    expect(describePluginFailures(failures)).not.toContain('已回报')
    expect(describePluginFailures(failures)).toContain('DELETE /admin/manifest/plugins/<名字>')
  })
})

describe('unresolvedBindings', () => {
  it('挑出 unresolved，skipped 不算——CF_*=none 是「这个资源不存在」，不是没解析出来', () => {
    expect(unresolvedBindings({ bindings: { kv: 'resolved', d1: 'unresolved', r2: 'skipped' } })).toEqual(['D1'])
  })

  it('全部解析好时为空', () => {
    expect(unresolvedBindings({ bindings: { kv: 'resolved', d1: 'resolved', r2: 'resolved' } })).toEqual([])
  })

  it('D1/R2 同样能被拦下——它们在上传元数据里是「整个绑定不出现」，扫占位符只看得见 KV', () => {
    expect(unresolvedBindings({ bindings: { kv: 'resolved', d1: 'unresolved', r2: 'unresolved' } })).toEqual(['D1', 'R2'])
  })

  it('旧产物没有 bindings 字段 → null，调用方据此拒绝部署而不是当成"没问题"', () => {
    expect(unresolvedBindings({ metadata: {} })).toBeNull()
  })

  // KV 是运行时必需的资源：旧投影器会把 CF_KV_ID=none 标成 skipped，这里兜住
  it('KV 标 skipped 也算没解析出来', () => {
    expect(unresolvedBindings({ bindings: { kv: 'skipped', d1: 'resolved', r2: 'skipped' } })).toEqual(['KV'])
  })

  it('报错里说清 KV 不能跳过', () => {
    expect(describeUnresolvedBindings(['KV'])).toContain('CF_KV_ID=none 不受支持')
    expect(describeUnresolvedBindings(['D1'])).not.toContain('CF_KV_ID=none')
    expect(describeUnresolvedBindings(['D1'])).toContain('基础设施绑定未解析：D1')
  })
})

describe('envFromRemoteConfig', () => {
  const full = {
    workerName: 'mybot',
    kvId: 'kv-1',
    d1Id: 'd1-1',
    r2Name: 'mybot-artifacts',
    defaultDomain: 'mybot.sub.workers.dev',
    hasD1: true,
    hasR2: true,
  }

  it('把 build-config 的回答映射成 CF_* 环境变量', () => {
    expect(envFromRemoteConfig(full, {})).toEqual({
      CF_WORKER_NAME: 'mybot',
      CF_KV_ID: 'kv-1',
      CF_D1_ID: 'd1-1',
      CF_R2_NAME: 'mybot-artifacts',
      CF_DEFAULT_DOMAIN: 'mybot.sub.workers.dev',
    })
  })

  it('构建环境里显式设置的优先，不覆盖', () => {
    const env = envFromRemoteConfig(full, { CF_KV_ID: 'mine', CF_R2_NAME: 'none' })
    expect(env).not.toHaveProperty('CF_KV_ID')
    expect(env).not.toHaveProperty('CF_R2_NAME')
    expect(env.CF_D1_ID).toBe('d1-1')
  })

  it('R2 未激活被降级（hasR2 为假、没有桶名）→ CF_R2_NAME=none，部署护栏按跳过放行', () => {
    // 不补的话模板里的 r2_buckets[0] 解析成 unresolved，每一次构建都被护栏拒绝
    const env = envFromRemoteConfig({ ...full, r2Name: null, hasR2: false }, {})
    expect(env.CF_R2_NAME).toBe('none')
  })

  it('D1 选了 none（hasD1 为假）→ CF_D1_ID=none，与 manifestPolicy 的 no-d1 分支配套', () => {
    const env = envFromRemoteConfig({ ...full, d1Id: null, hasD1: false }, {})
    expect(env.CF_D1_ID).toBe('none')
  })

  it('绑着但 secret 没写（id 为 null 而 has* 为真）→ 不补，交给护栏拒绝', () => {
    // 这时补 none 会把真实存在的绑定从新版本里剥掉，env.DB / env.R2 当场消失
    const env = envFromRemoteConfig({ ...full, d1Id: null, r2Name: null }, {})
    expect(env).not.toHaveProperty('CF_D1_ID')
    expect(env).not.toHaveProperty('CF_R2_NAME')
  })

  it('旧版 Worker 没有 has* 字段 → 不猜', () => {
    const env = envFromRemoteConfig({ kvId: 'kv-1', d1Id: null, r2Name: null }, {})
    expect(env).toEqual({ CF_KV_ID: 'kv-1' })
  })

  it('拿不到 build-config → 什么都不补', () => {
    expect(envFromRemoteConfig(null, {})).toEqual({})
  })
})

describe('manifestPolicy', () => {
  const failed = { ok: false, error: 'HTTP 500' }

  it('没配 MANIFEST_URL：跳过，用仓库内置清单', () => {
    expect(manifestPolicy({ skipped: true }, null, {})).toBe('skip')
  })

  it('拉到了就用拉到的', () => {
    expect(manifestPolicy({ ok: true, plugins: [] }, { hasD1: true }, {})).toBe('use-remote')
  })

  it('拉不到且不知道有没有 D1 → 硬失败', () => {
    expect(manifestPolicy(failed, null, {})).toBe('fail')
  })

  it('拉不到但确实没绑 D1 → 继续', () => {
    expect(manifestPolicy(failed, { hasD1: false }, {})).toBe('no-d1')
  })

  it('绑着 D1 只是 CF_D1_ID 没写（d1Id 为 null 而 hasD1 为真）→ 仍然硬失败', () => {
    // 这是最危险的一种：拿 d1Id 去猜会误判成「没有 D1」，然后静默把装好的插件从 Worker 上抹掉
    expect(manifestPolicy(failed, { d1Id: null, hasD1: true }, {})).toBe('fail')
  })

  it('旧版 Worker 没有 hasD1 字段 → 硬失败，不猜', () => {
    expect(manifestPolicy(failed, { d1Id: null }, {})).toBe('fail')
  })

  it('MANIFEST_FALLBACK=1 才显式放行', () => {
    expect(manifestPolicy(failed, { hasD1: true }, { MANIFEST_FALLBACK: '1' })).toBe('forced-fallback')
    expect(manifestPolicy(failed, { hasD1: true }, { MANIFEST_FALLBACK: 'true' })).toBe('fail')
  })
})

describe('resolveScriptName', () => {
  it('取生成配置的 name——模板里的名字是错的来源', () => {
    expect(resolveScriptName({ name: 'mybot' }, {})).toBe('mybot')
  })

  it('环境变量优先', () => {
    expect(resolveScriptName({ name: 'mybot' }, { CF_WORKER_NAME: ' other ' })).toBe('other')
  })

  it('两边都没有 → null，调用方报错而不是瞎猜一个默认名', () => {
    expect(resolveScriptName({}, {})).toBeNull()
  })
})

describe('WRANGLER_CI_OVERRIDE_NAME', () => {
  it('取 Workers Builds 注入的名字，去空白；没有就是 null', () => {
    expect(ciOverrideName({ WRANGLER_CI_OVERRIDE_NAME: ' mybot ' })).toBe('mybot')
    expect(ciOverrideName({ WRANGLER_CI_OVERRIDE_NAME: '' })).toBeNull()
    expect(ciOverrideName({})).toBeNull()
  })

  it('与部署目标名不一致时给醒目告警；一致或没有注入时不说话', () => {
    const text = describeNameMismatch('mybot', { WRANGLER_CI_OVERRIDE_NAME: 'otherbot' })
    expect(text).toContain('部署目标名对不上')
    expect(text).toContain('mybot')
    expect(text).toContain('otherbot')
    expect(describeNameMismatch('mybot', { WRANGLER_CI_OVERRIDE_NAME: 'mybot' })).toBeNull()
    expect(describeNameMismatch('mybot', {})).toBeNull()
  })
})

describe('classifyDeployError', () => {
  const cfError = (status, errors = []) => Object.assign(new Error('x'), { name: 'CloudflareApiError', status, errors })

  it('10007 = 脚本不存在，降级去创建', () => {
    expect(classifyDeployError(cfError(404, [{ code: 10007 }]))).toBe('script-not-found')
  })

  it('401/403 = 凭证权限模型不同，降级重试', () => {
    expect(classifyDeployError(cfError(401))).toBe('credentials')
    expect(classifyDeployError(cfError(403))).toBe('credentials')
  })

  it('其余 Cloudflare 错误上抛，不降级', () => {
    expect(classifyDeployError(cfError(500, [{ code: 10001 }]))).toBe('rethrow')
  })

  it('两个安全阀绝不降级——降级会把它们整个绕过去', () => {
    expect(classifyDeployError(Object.assign(new Error('丢 secret'), { name: 'SecretLossError' }))).toBe('rethrow')
    expect(classifyDeployError(Object.assign(new Error('健康检查失败'), { name: 'HealthCheckError' }))).toBe('rethrow')
  })

  it('普通 Error 也上抛', () => {
    expect(classifyDeployError(new Error('boom'))).toBe('rethrow')
    expect(classifyDeployError(undefined)).toBe('rethrow')
  })

  // 回归：版本已上传后某一步报 403 以前也会降级，wrangler deploy 绕过健康检查直接上线
  it('只有上传那一步的错误才降级；之后任何一步的 401/403/10007 都上抛', () => {
    expect(classifyDeployError(Object.assign(cfError(403), { stage: 'upload' }))).toBe('credentials')
    expect(classifyDeployError(Object.assign(cfError(404, [{ code: 10007 }]), { stage: 'upload' }))).toBe('script-not-found')
    for (const stage of ['secrets', 'subdomain', 'health', 'promote']) {
      expect(classifyDeployError(Object.assign(cfError(403), { stage }))).toBe('rethrow')
      expect(classifyDeployError(Object.assign(cfError(404, [{ code: 10007 }]), { stage }))).toBe('rethrow')
    }
  })
})

describe('planDeployFallback', () => {
  const cfError = (status, errors = [], stage = 'upload') =>
    Object.assign(new Error(`HTTP ${status}`), { name: 'CloudflareApiError', status, errors, stage })
  const notFound = () => cfError(404, [{ code: 10007 }])

  it('名字一致或没注入：与以前一样，10007 与 401/403 降级', () => {
    expect(planDeployFallback(notFound(), 'mybot', {})).toEqual({ action: 'wrangler', reason: 'Worker mybot 尚未在 Cloudflare 创建' })
    expect(planDeployFallback(notFound(), 'mybot', { WRANGLER_CI_OVERRIDE_NAME: 'mybot' })).toMatchObject({ action: 'wrangler' })
    expect(planDeployFallback(cfError(403), 'mybot', {})).toEqual({
      action: 'wrangler',
      reason: 'Versions API 拒绝了本次调用（HTTP 403：HTTP 403）',
    })
  })

  // 否则以后每次都静默降级、跳过健康检查；名字碰巧是同账号另一个 bot 时还会部署到它身上
  it('10007 且与 Workers Builds 连着的 Worker 名对不上：不降级，说明是名字错了', () => {
    const plan = planDeployFallback(notFound(), 'mybot', { WRANGLER_CI_OVERRIDE_NAME: 'realbot' })
    expect(plan.action).toBe('fail')
    expect(plan.message).toContain('名字对不上')
    expect(plan.message).toContain('realbot')
    expect(plan.message).toContain('CF_WORKER_NAME')
  })

  it('401/403 且名字对不上：照旧降级，但说清 wrangler 实际会部署到哪', () => {
    const plan = planDeployFallback(cfError(403), 'mybot', { WRANGLER_CI_OVERRIDE_NAME: 'realbot' })
    expect(plan.action).toBe('wrangler')
    expect(plan.reason).toContain('wrangler 会部署到 realbot')
  })

  it('上抛的照旧上抛', () => {
    expect(planDeployFallback(cfError(500), 'mybot', {})).toEqual({ action: 'rethrow' })
    expect(planDeployFallback(cfError(403, [], 'promote'), 'mybot', {})).toEqual({ action: 'rethrow' })
    expect(planDeployFallback(Object.assign(new Error('x'), { name: 'HealthCheckError' }), 'mybot', {})).toEqual({ action: 'rethrow' })
  })
})

describe('healthFailures', () => {
  it('source 取 D1 里记的原始来源（origin.source），不是构建机上改写后的产物路径', () => {
    const plugins = [
      { name: 'weather', source: 'file:/tmp/qqbot-build-plugins/weather/dist/plugin.js', origin: { from: 'd1', source: 'git:me/weather@a1b2c3d4' } },
      { name: 'echo', source: 'file:../../plugins/echo/dist/plugin.js' },
    ]
    expect(
      healthFailures(
        [
          { name: 'weather', message: 'boom' },
          { name: 'echo', message: 'x' },
          { name: 'ghost', message: 'y' },
        ],
        plugins,
      ),
    ).toEqual([
      { name: 'weather', source: 'git:me/weather@a1b2c3d4', error: '预览版本里加载失败：boom' },
      { name: 'echo', source: 'file:../../plugins/echo/dist/plugin.js', error: '预览版本里加载失败：x' },
      { name: 'ghost', source: '', error: '预览版本里加载失败：y' },
    ])
  })

  it('健康检查阶段的失败换个说法：是加载失败、没切流量', () => {
    const text = describePluginFailures([{ name: 'a', source: 'git:me/a@a1b2c3d4', error: 'x' }], { phase: 'health', reported: true })
    expect(text).toContain('预览健康检查里加载失败，未切换流量')
    expect(text).not.toContain('构建失败')
  })
})
