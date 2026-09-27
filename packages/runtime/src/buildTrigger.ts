/**
 * 经 Cloudflare Builds REST API 触发 Workers Builds 重建：确定构建目标（workerTag + triggerUuid）、
 * 补写 trigger 的构建配置、选分支触发并记账本（POST /admin/builds），以及改完清单之后要不要构建。
 */
import { BUILD_COMMAND, CloudflareBuildsApi, DEPLOY_COMMAND, mergePathExcludes, productionBranchOf } from '@qqbot/projector'
import { requireDb } from './adminDb.js'
import { error, json, readJson } from './http.js'
import { liveManifestHash } from './managedPlugins.js'
import {
  insertInstall,
  listInstalls,
  listManifestPlugins,
  manifestHash,
  markPendingBuilding,
  settlePendingInstalls,
  type InstallRecord,
} from './manifestStore.js'
import { Keys } from './store.js'
import type { RequestScope } from './scope.js'
import type { AdminDeps } from './admin.js'

/** 安装、升级、卸载之后的构建结果：触发了、触发失败、或者不需要 */
type BuildResponse = { buildUuid: string } | { error: string } | { skipped: true; reason: string }

/**
 * 改完清单之后要不要构建。
 *
 * D1 的期望状态已经和线上这份部署一模一样——撤掉的是还没上线的改动，比如卸载一个从没装上的插件——
 * 就不必白跑一次，构建出来还是现在这份；账本里的 pending 记录直接算完成。线上没有出处信息（老部署）
 * 判断不了，照旧触发；还有构建在跑时也照旧触发：在跑的那次可能拉的是改动之前的清单。
 */
export async function buildAfterChange(
  scope: RequestScope,
  deps: AdminDeps,
  // 调用方改完清单后算的 manifestHash：那之后它没再写过清单，这里和 triggerProjectionBuild 都不必再查一次 D1
  hash: string,
): Promise<BuildResponse> {
  const db = scope.env.DB
  if (db) {
    const live = await liveManifestHash(deps.registry)
    if (live !== null && live === hash) {
      const building = (await listInstalls(db, 50)).some((r) => r.status === 'building')
      if (!building) {
        await settlePendingInstalls(db)
        return { skipped: true, reason: '插件清单已与线上部署一致，不需要构建' }
      }
    }
  }
  const build = await triggerProjectionBuild(scope, deps, undefined, hash)
  return build.ok ? { buildUuid: build.buildUuid } : { error: build.error }
}

export const BUILD_DEFERRED: BuildResponse = { skipped: true, reason: '按请求暂不构建：改完之后调一次 POST /admin/builds' }

// ---------- 构建触发与账本 ----------

export function buildsApi(scope: RequestScope, deps: AdminDeps): CloudflareBuildsApi | null {
  const { CF_ACCOUNT_ID, CF_BUILDS_TOKEN } = scope.env
  if (!CF_ACCOUNT_ID || !CF_BUILDS_TOKEN) return null
  return new CloudflareBuildsApi({ accountId: CF_ACCOUNT_ID, apiToken: CF_BUILDS_TOKEN, fetchImpl: deps.options.fetchImpl })
}

interface BuildTargets {
  workerTag: string
  triggerUuid: string
}

async function readCachedTargets(scope: RequestScope): Promise<BuildTargets | null> {
  try {
    const cached = await scope.env.KV.get(Keys.cfBuildTargets, 'json')
    if (typeof cached === 'object' && cached !== null) {
      const { workerTag, triggerUuid } = cached as Record<string, unknown>
      if (typeof workerTag === 'string' && typeof triggerUuid === 'string') return { workerTag, triggerUuid }
    }
  } catch {
    // KV 读失败不阻塞，直接走自发现
  }
  return null
}

/**
 * trigger 配置写到了第几版，记在 KV 标记里：
 * 1 = 构建命令与清单环境变量；2 = 再加上 Build watch paths 的排除路径（BUILD_PATH_EXCLUDES）。
 * 老版本写的标记是写入时间（ISO 字符串），算作 1——已部署的机器人下次触发构建时只补排除路径，别的不动。
 */
const TRIGGER_CONFIG_VERSION = 2

function triggerConfigVersion(marker: string | null): number {
  if (!marker) return 0
  try {
    const version = (JSON.parse(marker) as { version?: unknown } | null)?.version
    return typeof version === 'number' ? version : 1
  } catch {
    return 1
  }
}

/**
 * 把构建命令、清单环境变量与排除路径写进 trigger。
 *
 * 网页向导在用户连完仓库时就写好了；这条路径是给**无 UI 引导**和「后来重连过仓库」兜底的——
 * 那两种情况下引导跑完时 trigger 还不存在，写不了，用户就只能照 Summary 手抄四项。
 * 而这四项里最容易配错的恰好是 MANIFEST_TOKEN 与 Worker 侧 BUILD_TOKEN 的对齐，
 * 两个值本来就在同一个 env 里，没有理由让人肉搬运。
 *
 * 每一版只写一次（KV 打标），避免覆盖用户后来在后台的手动调整；排除路径在已有的上面合并，
 * 用户自己加的不丢。失败只记日志不阻断触发构建。
 */
async function ensureTriggerConfigured(
  api: CloudflareBuildsApi,
  targets: BuildTargets,
  scope: RequestScope,
  deps: AdminDeps,
): Promise<void> {
  // 只用默认域名：它直连 Cloudflare 边缘、不依赖用户的 DNS。
  // 拿不到自己的对外地址就别乱写——写进去一个错的 MANIFEST_URL 比不写更难查
  const domain = scope.env.CF_DEFAULT_DOMAIN
  if (!domain || !scope.env.BUILD_TOKEN) return
  try {
    const done = triggerConfigVersion(await scope.env.KV.get(Keys.cfTriggerConfigured))
    if (done >= TRIGGER_CONFIG_VERSION) return
    const current = (await api.listTriggers(targets.workerTag)).find((t) => t.uuid === targets.triggerUuid)
    await api.updateTrigger(targets.triggerUuid, {
      ...(done < 1 ? { build_command: BUILD_COMMAND, deploy_command: DEPLOY_COMMAND } : {}),
      path_excludes: mergePathExcludes(current?.pathExcludes ?? []),
    })
    if (done < 1) {
      await api.putTriggerEnv(targets.triggerUuid, {
        MANIFEST_URL: { value: `https://${domain}/admin/build-manifest`, is_secret: false },
        MANIFEST_TOKEN: { value: scope.env.BUILD_TOKEN, is_secret: true },
      })
    }
    await scope.env.KV.put(Keys.cfTriggerConfigured, JSON.stringify({ version: TRIGGER_CONFIG_VERSION, at: new Date().toISOString() }))
    deps.logger.info(done < 1 ? '已写入构建 trigger 配置（构建命令、清单环境变量与排除路径）' : '已给构建 trigger 补上排除路径')
  } catch (err) {
    deps.logger.warn('写入构建 trigger 配置失败，需要到 Cloudflare 后台手动填写', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function clearCachedTargets(scope: RequestScope): Promise<void> {
  try {
    await scope.env.KV.delete(Keys.cfBuildTargets)
  } catch {
    // 删失败顶多下次多试一次无效 trigger
  }
}

/**
 * 解析构建目标（workerTag + triggerUuid）：env 显式配置优先，其次 KV 缓存，
 * 最后 API 自发现（listScripts 按 WORKER_NAME 找 tag，再查 triggers）。
 * 自发现让 CF_WORKER_TAG / CF_TRIGGER_UUID 成为可选——连接仓库之前这两者并不存在，
 * 引导流程不必再教用户 curl 两个 API。
 * 返回 null 表示缺 CF_ACCOUNT_ID / CF_BUILDS_TOKEN；其余失败抛带指引的 Error。
 */
export async function resolveBuildTargets(scope: RequestScope, deps: AdminDeps): Promise<BuildTargets | null> {
  const { CF_WORKER_TAG, CF_TRIGGER_UUID } = scope.env
  const api = buildsApi(scope, deps)
  // 目标写死在 env 里也要补构建配置——写死的是「哪个 trigger」，不是「trigger 里配了什么」
  if (CF_WORKER_TAG && CF_TRIGGER_UUID) {
    const fixed = { workerTag: CF_WORKER_TAG, triggerUuid: CF_TRIGGER_UUID }
    if (api) await ensureTriggerConfigured(api, fixed, scope, deps)
    return fixed
  }
  if (!api) return null

  const cached = await readCachedTargets(scope)
  const discover = async (): Promise<BuildTargets> => {
    const scriptName = typeof scope.env.WORKER_NAME === 'string' && scope.env.WORKER_NAME ? scope.env.WORKER_NAME : 'qqbot'
    const scripts = await api.listScripts()
    const me = scripts.find((s) => s.id === scriptName)
    if (!me) {
      throw new Error(
        `账号里找不到脚本 ${scriptName}（来自 vars.WORKER_NAME）——若改过 wrangler.jsonc 的 name，请把 vars.WORKER_NAME 一起改`,
      )
    }
    const triggerUuid = await api.getTriggerUuid(me.tag)
    if (!triggerUuid) {
      throw new Error('仓库尚未连接 Workers Builds（查不到 trigger）——请到 Cloudflare 后台 Worker → Settings → Builds 连接仓库后重试')
    }
    return { workerTag: me.tag, triggerUuid }
  }

  let targets = cached ?? (await discover())
  // env 里配了一半的（比如只给了 CF_WORKER_TAG）按 env 补齐
  if (CF_WORKER_TAG || CF_TRIGGER_UUID) targets = { workerTag: CF_WORKER_TAG ?? targets.workerTag, triggerUuid: CF_TRIGGER_UUID ?? targets.triggerUuid }
  if (!cached) {
    try {
      await scope.env.KV.put(Keys.cfBuildTargets, JSON.stringify(targets))
    } catch {
      // 缓存写失败不影响本次
    }
  }
  await ensureTriggerConfigured(api, targets, scope, deps)
  return targets
}

/**
 * 这个 trigger 当前的生产分支（连接仓库时选的那个）。每次触发构建都现查、不缓存：
 * 在 Cloudflare 后台改生产分支不会换 trigger_uuid，缓存了就会一直往旧分支上触发——
 * 旧分支还在的话，甚至会悄悄构建旧代码。多一次 GET，构建本来就不频繁。
 * 查不到返回 null，由调用方回退。
 */
async function productionBranch(api: CloudflareBuildsApi, targets: BuildTargets, deps: AdminDeps): Promise<string | null> {
  try {
    const trigger = (await api.listTriggers(targets.workerTag)).find((t) => t.uuid === targets.triggerUuid)
    return trigger ? productionBranchOf(trigger) : null
  } catch (err) {
    deps.logger.warn('读取构建 trigger 的生产分支失败，按 main 触发', { error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

/** 触发一次 Workers Build 重建当前清单；build 端点与插件一键更新共用 */
async function triggerProjectionBuild(
  scope: RequestScope,
  deps: AdminDeps,
  branch?: string,
  // buildAfterChange 带进来的当前清单哈希；POST /admin/builds 不带，照旧自己查
  knownHash?: string,
): Promise<{ ok: true; buildUuid: string; branch: string; hash: string; install: InstallRecord } | { ok: false; error: string; status: number }> {
  const env = scope.env
  if (!env.CF_ACCOUNT_ID || !env.CF_BUILDS_TOKEN) {
    return { ok: false, status: 503, error: '自部署未配置：缺少 CF_ACCOUNT_ID / CF_BUILDS_TOKEN（设置步骤见 seed README）' }
  }
  const db = await requireDb(scope)
  if (!db) return { ok: false, status: 503, error: '未绑定 D1，无法记录构建' }

  const hash = knownHash ?? (await manifestHash(await listManifestPlugins(db)))
  const api = buildsApi(scope, deps)
  if (!api) return { ok: false, status: 503, error: '自部署未配置：缺少 CF_ACCOUNT_ID / CF_BUILDS_TOKEN' }
  // 分支：请求里指定的 > CF_BUILD_BRANCH > 连接仓库时选的生产分支 > main。
  // 以前直接落到 main：fork 后改了分支名、或连接时选了别的分支，引导那次构建没事，之后面板触发的全指错分支
  const branchFor = async (t: BuildTargets) => branch ?? env.CF_BUILD_BRANCH ?? (await productionBranch(api, t, deps)) ?? 'main'

  let targets: BuildTargets | null = null
  try {
    targets = await resolveBuildTargets(scope, deps)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, status: 502, error: `确定构建目标失败：${message}` }
  }
  if (!targets) return { ok: false, status: 503, error: '自部署未配置：缺少 CF_ACCOUNT_ID / CF_BUILDS_TOKEN' }

  let branchName = await branchFor(targets)
  let buildUuid: string
  try {
    ;({ buildUuid } = await api.triggerBuild(targets.triggerUuid, { branch: branchName }))
  } catch (err) {
    const firstError = err instanceof Error ? err.message : String(err)
    // 缓存的 trigger_uuid 可能已失效（重连过仓库会换新）：清缓存重新解析，只重试一次。
    // 解析结果与原来相同（env 配死或确实没变）就按原错误失败，不做无谓重试。
    await clearCachedTargets(scope)
    const refreshed = await resolveBuildTargets(scope, deps).catch(() => null)
    if (!refreshed || refreshed.triggerUuid === targets.triggerUuid) {
      await insertInstall(db, { action: 'build', name: null, source: null, manifestHash: hash, status: 'failed', error: firstError })
      return { ok: false, status: 502, error: `触发构建失败（分支 ${branchName}）：${firstError}` }
    }
    branchName = await branchFor(refreshed)
    try {
      ;({ buildUuid } = await api.triggerBuild(refreshed.triggerUuid, { branch: branchName }))
    } catch (err2) {
      const message = err2 instanceof Error ? err2.message : String(err2)
      await insertInstall(db, { action: 'build', name: null, source: null, manifestHash: hash, status: 'failed', error: message })
      return { ok: false, status: 502, error: `触发构建失败（分支 ${branchName}）：${message}` }
    }
  }

  await markPendingBuilding(db, buildUuid)
  const install = await insertInstall(db, {
    action: 'build',
    name: null,
    source: null,
    manifestHash: hash,
    status: 'building',
    buildUuid,
  })
  return { ok: true, buildUuid, branch: branchName, hash, install }
}

/** POST /admin/builds —— 触发 Workers Builds 重建当前清单（body 可传 { branch }） */
export async function triggerBuild(request: Request, scope: RequestScope, deps: AdminDeps): Promise<Response> {
  const body = await readJson<{ branch?: string }>(request).catch(() => null)
  const out = await triggerProjectionBuild(scope, deps, body?.branch?.trim() || undefined)
  if (!out.ok) return error(out.error, out.status)
  return json({ ok: true, buildUuid: out.buildUuid, branch: out.branch, hash: out.hash, install: out.install })
}
