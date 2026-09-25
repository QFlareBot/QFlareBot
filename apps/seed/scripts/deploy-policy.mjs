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
