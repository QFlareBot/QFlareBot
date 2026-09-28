/** Workers Builds：构建命令与排除路径，以及网页向导第 ④ ⑤ 步用到的 trigger / 构建接口 */

import { BootstrapError, cfFetch } from './cf.mjs'

/**
 * 构建机上的构建与部署命令。向导会经 Builds API 直接写进 trigger；
 * headless 模式连接仓库时 trigger 还不存在，只能打进 Summary 让人照抄。
 *
 * 权威定义在 `packages/projector/src/builds.ts`（Worker 侧自动写 trigger 要用）。
 * 这里是副本——引导是裸 Node 脚本，跑在 `pnpm build` 之前，import 不到构建产物。
 * 两边由 `packages/projector/src/builds.test.ts` 断言一致，改一处 CI 会红。
 */
export const BUILD_COMMAND = 'pnpm build && pnpm --filter @qqbot/seed run manifest:prepare'
export const DEPLOY_COMMAND = 'pnpm --filter @qqbot/seed run manifest:deploy'

/**
 * 推送时不必重建机器人的路径（trigger 的 Build watch paths → Exclude）：只改文档、模板、工作流
 * 不再白占一次构建。权威定义同样在 `packages/projector/src/builds.ts`，由那边的测试断言一致。
 */
export const BUILD_PATH_EXCLUDES = ['docs/*', 'templates/*', '.github/*', 'scripts/*', 'design-system/*', '*.md', 'LICENSE']

/** 在 trigger 已有的排除路径上补齐：API 没说 PATCH 数组是替换还是合并，按替换处理，用户自己加的不丢 */
export function mergePathExcludes(existing) {
  return [...new Set([...(existing ?? []), ...BUILD_PATH_EXCLUDES])]
}

/** 按脚本名找 Builds API 用的 tag——脚本名（id）与 tag 不是一回事 */
export async function findWorkerTag(token, accountId, workerName) {
  const scripts = await cfFetch(token, `/accounts/${accountId}/workers/scripts`)
  const me = (Array.isArray(scripts) ? scripts : scripts?.items ?? []).find((s) => s?.id === workerName)
  if (!me?.tag) throw new BootstrapError(`账户里找不到 Worker ${workerName}`)
  return me.tag
}

/**
 * 列 Worker 的 Builds trigger；仓库连上之前为空。
 *
 * 404 按「还没连接」处理（未连接时 Cloudflare 回什么没有文档，未实测）。
 * 403 抛出时带 `missingPermission`：它通常是缺 Workers 构建配置权限，但没连接时是否也回 403
 * 同样没有文档——所以连接前拿到 403 的调用方不该当场报红，见 wizard 的连接检测。
 *
 * @param who 报错里怎么称呼这个 token（「主 Token」「构建 Token」）
 */
export async function listTriggers(token, accountId, workerTag, who) {
  try {
    const triggers = await cfFetch(token, `/accounts/${accountId}/builds/workers/${workerTag}/triggers`)
    return Array.isArray(triggers) ? triggers : triggers?.items ?? []
  } catch (err) {
    if (!(err instanceof BootstrapError)) throw err
    if (err.status === 404) return []
    if (err.status === 403) {
      const denied = new BootstrapError(
        `${who}缺少「Workers 构建配置（编辑）」权限（英文界面叫 Workers Builds Configuration，也可能显示为 Workers CI）——` +
          '到 Cloudflare 的 API Tokens 页编辑这个 token 补上这项（token 值不变）',
        { status: 403 },
      )
      denied.missingPermission = true
      throw denied
    }
    throw err
  }
}

/**
 * 从 trigger 列表里挑生产 trigger，返回 { uuid, branch, pathExcludes }；没有则 null。
 *
 * 连接时勾了「非生产分支构建」，Cloudflare 会另建一个预览 trigger：branch_includes 是 ["*"]、
 * 排除生产分支。取列表第一个可能正好取到它——往里写 manifest:deploy，任何分支一推就切 100% 流量。
 * 生产 trigger 的 branch_includes 是具体分支名；字段缺失（响应形状变了）时按生产处理、分支记 main。
 * pathExcludes 是它现有的排除路径，写配置时在它上面合并。buildCommand / deployCommand / buildCaching
 * 是它现在的设置，重跑时据此判断要不要改（响应里没有就是 undefined，按「要改」处理）。
 */
export function pickProductionTrigger(triggers) {
  for (const t of triggers ?? []) {
    const uuid = t?.trigger_uuid ?? t?.uuid ?? t?.id
    if (typeof uuid !== 'string' || !uuid) continue
    const includes = Array.isArray(t.branch_includes) ? t.branch_includes : []
    const settings = {
      pathExcludes: Array.isArray(t.path_excludes) ? t.path_excludes.filter((p) => typeof p === 'string') : [],
      buildCommand: typeof t.build_command === 'string' ? t.build_command : undefined,
      deployCommand: typeof t.deploy_command === 'string' ? t.deploy_command : undefined,
      buildCaching: typeof t.build_caching_enabled === 'boolean' ? t.build_caching_enabled : undefined,
    }
    const branch = includes.find((b) => typeof b === 'string' && b && !b.includes('*'))
    if (branch) return { uuid, branch, ...settings }
    if (!includes.length) return { uuid, branch: 'main', ...settings }
  }
  return null
}

/**
 * 把构建命令、清单环境变量、排除路径与构建缓存开关写进 trigger。
 *
 * 这几项以前只出现在 Summary 的照抄块里，而向导用户那时早已离开 run 页：走完向导 →
 * 去面板装插件 → 构建机用默认命令跑 → 失败，面板上只显示「失败」。
 * 排除路径（BUILD_PATH_EXCLUDES）让只改文档的推送不再重建机器人；
 * 构建缓存（默认关）缓存 npm / pnpm 下载的包，装依赖快一些。
 */
export async function configureTrigger(token, accountId, triggerUuid, { manifestUrl, buildToken, pathExcludes = [] }) {
  await updateTriggerSettings(token, accountId, triggerUuid, pathExcludes)
  await setTriggerEnv(token, accountId, triggerUuid, { manifestUrl, buildToken })
}

/** 构建命令、部署命令、排除路径（在已有的上面合并）与构建缓存 */
export async function updateTriggerSettings(token, accountId, triggerUuid, pathExcludes = []) {
  await cfFetch(token, `/accounts/${accountId}/builds/triggers/${triggerUuid}`, {
    method: 'PATCH',
    body: {
      build_command: BUILD_COMMAND,
      deploy_command: DEPLOY_COMMAND,
      path_excludes: mergePathExcludes(pathExcludes),
      build_caching_enabled: true,
    },
  })
}

/** 清单变量；没给的那个不动（重跑时 MANIFEST_TOKEN 常常要保持原样：Worker 上那份的值读不到） */
export async function setTriggerEnv(token, accountId, triggerUuid, { manifestUrl, buildToken }) {
  const body = {
    ...(manifestUrl ? { MANIFEST_URL: { value: manifestUrl, is_secret: false } } : {}),
    ...(buildToken ? { MANIFEST_TOKEN: { value: buildToken, is_secret: true } } : {}),
  }
  if (!Object.keys(body).length) return
  await cfFetch(token, `/accounts/${accountId}/builds/triggers/${triggerUuid}/environment_variables`, { method: 'PATCH', body })
}

/** trigger 现有的环境变量：{ 名字: { value, isSecret } }；secret 的 value 读回来是 null */
export async function listTriggerEnv(token, accountId, triggerUuid) {
  const result = await cfFetch(token, `/accounts/${accountId}/builds/triggers/${triggerUuid}/environment_variables`)
  const out = {}
  for (const [name, v] of Object.entries(result ?? {})) {
    out[name] = { value: typeof v?.value === 'string' ? v.value : null, isSecret: v?.is_secret === true }
  }
  return out
}

/** 这个 trigger 最近一次构建的结论（success / failure / canceled…）；还在跑或一次都没有时为 null */
export async function latestBuildOutcome(token, accountId, workerTag, triggerUuid) {
  const builds = await cfFetch(token, `/accounts/${accountId}/builds/workers/${workerTag}/builds?per_page=10`)
  const mine = (Array.isArray(builds) ? builds : [])
    .filter((b) => !b?.trigger?.trigger_uuid || b.trigger.trigger_uuid === triggerUuid)
    .sort((a, b) => String(b?.created_on ?? '').localeCompare(String(a?.created_on ?? '')))
  const last = mine[0]
  return typeof last?.build_outcome === 'string' && last.build_outcome ? last.build_outcome : null
}

/**
 * 连上仓库之后这次要做哪些事。重跑引导时 trigger 往往早就配好了：全都一致、上一次构建也成功，
 * 就什么都不写、不补跑——免得每重跑一次就白花一次构建时长。
 *
 * MANIFEST_TOKEN 三种处理：
 * - write：这次手里有 BUILD_TOKEN 的值（首次生成或显式给的），照写；
 * - keep：值读不到，但 trigger 上已经有、且上一次构建成功——说明两边对得上，保持原样；
 * - rotate：值读不到，trigger 上又没有或者上次构建没成功，就地换一个新值（先写 trigger、再写 Worker）。
 *
 * @param {{ trigger: ReturnType<typeof pickProductionTrigger>, env: Record<string, { value: string | null }> | null,
 *           manifestUrl: string, buildToken: string | null, lastOutcome: string | null }} input
 *   env / lastOutcome 读不到时传 null：按「不确定」处理，照首次那样全写、补跑
 */
export function planTriggerSetup({ trigger, env, manifestUrl, buildToken, lastOutcome }) {
  const settingsOk =
    trigger.buildCommand === BUILD_COMMAND &&
    trigger.deployCommand === DEPLOY_COMMAND &&
    trigger.buildCaching === true &&
    BUILD_PATH_EXCLUDES.every((p) => trigger.pathExcludes.includes(p))
  const urlOk = env?.MANIFEST_URL?.value === manifestUrl
  const lastOk = lastOutcome === 'success'
  const manifestToken = buildToken ? 'write' : env?.MANIFEST_TOKEN && lastOk ? 'keep' : 'rotate'
  // 有改动就补跑一次验证；没改动时 keep 已经意味着上次构建成功，不必再跑
  const changed = !settingsOk || !urlOk || manifestToken !== 'keep'
  return { updateSettings: !settingsOk, updateUrl: !urlOk, manifestToken, startBuild: changed }
}

/** 手动触发一次构建，返回 build_uuid */
export async function startBuild(token, accountId, triggerUuid, branch) {
  const result = await cfFetch(token, `/accounts/${accountId}/builds/triggers/${triggerUuid}/builds`, {
    method: 'POST',
    body: { branch },
  })
  const buildUuid = result?.build_uuid ?? result?.uuid ?? result?.id
  if (typeof buildUuid !== 'string') throw new BootstrapError('触发构建的响应缺少 build_uuid')
  return buildUuid
}

/** 查一次构建的状态：{ status, outcome }；outcome 为空表示还在跑 */
export async function getBuild(token, accountId, buildUuid) {
  const b = await cfFetch(token, `/accounts/${accountId}/builds/builds/${buildUuid}`)
  return { status: b?.status ?? '', outcome: b?.build_outcome ?? '' }
}
