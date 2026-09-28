/**
 * 第 ② 步先问一句：这个名字的 Worker 部署过没有、上面有什么。重跑（比如破坏性更新之后）时，
 * 页面据此说清这次会做什么，并让用户选择沿用原来的面板密码。全是只读查询。
 */

import { findD1, findWorkerTag, inspectWorker, listTriggers, pickProductionTrigger, readInstalledPlugins } from '../lib.mjs'

/** 面板里装了几个插件（重跑会一起重新构建）；查不到就是 null，不影响部署 */
async function countPlugins(token, accountId, d1Name) {
  if (d1Name === 'none') return null
  try {
    const d1 = await findD1(token, accountId, d1Name)
    return d1 ? (await readInstalledPlugins(token, accountId, d1.id)).length : 0
  } catch {
    return null
  }
}

/** 仓库连没连过；查不到（比如主 token 缺构建配置权限）就是 null */
async function isConnected(token, accountId, workerName) {
  try {
    const tag = await findWorkerTag(token, accountId, workerName)
    return !!pickProductionTrigger(await listTriggers(token, accountId, tag, '主 Token'))
  } catch {
    return null
  }
}

export async function describeExisting({ token, accountId, workerName, d1Name }) {
  const worker = await inspectWorker(token, accountId, workerName)
  if (!worker.exists) return { workerName, exists: false }
  const [pluginCount, connected] = await Promise.all([countPlugins(token, accountId, d1Name || workerName), isConnected(token, accountId, workerName)])
  return {
    workerName,
    exists: true,
    hasAdminToken: worker.secretNames.includes('ADMIN_TOKEN'),
    hasBuildsToken: worker.secretNames.includes('CF_BUILDS_TOKEN'),
    pluginCount,
    connected,
  }
}
