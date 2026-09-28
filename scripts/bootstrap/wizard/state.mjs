/**
 * 向导的内存状态。token 只在这里，绝不回给页面；页面刷新后靠 resumeView 接着上次那一步走。
 */

export function createState(env) {
  return {
    token: null,
    accountId: env.BOOT_ACCOUNT_ID?.trim() || null,
    accounts: [],
    workerName: env.BOOT_WORKER_NAME?.trim() || 'qqbot',
    provision: null, // 见 provision.mjs 的 createProvision
    builds: null, // 检测到仓库连接后：{ tag, trigger: { uuid, branch, pathExcludes }, configured, error, buildUuid, buildStartedAt, build, buildError, apiToken }
    buildsBusy: null, // 进行中的连接检测（轮询会并发打进来）
    completion: null, // /api/complete 的回应，完成页刷新后照样显示
    closesAt: null, // 完成后自动退出的时间
    lastActivity: Date.now(),
  }
}

/**
 * 页面该停在哪一步：token → options → deploy → connect → builds → done。
 * 连上仓库之后停在 builds（构建 Token）：连接页的「下一步」是用户自己点的，刷新后不必再点一次。
 */
export function resumeStep(state) {
  if (state.completion) return 'done'
  const p = state.provision
  if (p?.ok) return state.builds ? 'builds' : 'connect'
  if (p) return 'deploy'
  if (state.token) return 'options'
  return 'token'
}

export function resumeView(state) {
  const verified = !!state.token
  return {
    step: resumeStep(state),
    accountId: verified ? state.accountId : null,
    accountName: verified ? (state.accounts.find((a) => a.id === state.accountId)?.name ?? null) : null,
    workerName: state.workerName,
    completion: state.completion,
  }
}
