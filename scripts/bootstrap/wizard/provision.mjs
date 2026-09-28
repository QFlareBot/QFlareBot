/**
 * 部署进度：runBootstrap 的每一步记成一行（带起止时间，页面据此显示用时），
 * 构建与部署的输出留最近几百行给「详细日志」。
 */

import { workerBuildsUrl, workerDomainsUrl } from '../lib.mjs'

const LOG_LIMIT = 400

export function createProvision() {
  return { steps: [], log: [], done: false, ok: false, error: null, hint: null, result: null }
}

/** runBootstrap 的 onStep：run 开一行，ok / warn / fail 收掉同名的那一行 */
export function recordStep(p, name, state, detail, now = Date.now()) {
  if (state === 'run') {
    p.steps.push({ name, state, detail: null, startedAt: now, endedAt: null })
    return
  }
  const open = p.steps.findLast((s) => s.name === name && s.state === 'run')
  if (open) Object.assign(open, { state, detail: detail ?? null, endedAt: now })
  else p.steps.push({ name, state, detail: detail ?? null, startedAt: now, endedAt: now })
}

export function recordOutput(p, line) {
  p.log.push(line)
  if (p.log.length > LOG_LIMIT) p.log.splice(0, p.log.length - LOG_LIMIT)
}

/**
 * 给页面看的引导结果：去掉 BUILD_TOKEN 的值与资源 id——页面用不到，就不经过浏览器。
 * 后台链接在这里拼好，页面不用知道 dash 的地址规则。
 */
export function resultView(result) {
  if (!result) return null
  const { accountId, workerName, resources } = result
  const resource = (r) => (r ? { name: r.name, created: r.created } : null)
  return {
    accountId,
    workerName,
    panelUrl: result.panelUrl,
    manifestUrl: result.manifestUrl,
    buildsTokenUrl: result.buildsTokenUrl,
    buildsConnectUrl: result.buildsConnectUrl,
    domainsUrl: workerDomainsUrl(accountId, workerName),
    buildsUrl: workerBuildsUrl(accountId, workerName),
    resources: { kv: resource(resources.kv), d1: resource(resources.d1), r2: resource(resources.r2) },
    warnings: result.warnings,
    redeployed: !!result.redeployed,
    adminTokenKept: !!result.adminTokenKept,
    buildsTokenExisting: !!result.buildsTokenExisting,
  }
}

export function progressView(p, now = Date.now()) {
  if (!p) return { started: false, steps: [], log: [], done: false, ok: false, now }
  return {
    started: true,
    steps: p.steps,
    log: p.log,
    done: p.done,
    ok: p.ok,
    error: p.error,
    hint: p.hint,
    result: resultView(p.result),
    now,
  }
}
