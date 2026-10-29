import { requireDb } from './adminDb.js'
import { BUILD_DEFERRED, buildAfterChange } from './buildTrigger.js'
import { error, json, readJson } from './http.js'
import {
  blockingProblem,
  dependencyWarnings,
  DO_MIGRATION_REQUIRED,
  fetchDeclaredManifest,
  inspectDependencies,
  inspectSource,
  installWarnings,
  knownDurableObjects,
  previousManifest,
  summarizeManifest,
  type Failure,
} from './installChecks.js'
import {
  getManifestPlugin,
  insertInstall,
  listManifestPluginRecords,
  listManifestPlugins,
  manifestHash,
  parseGitSource,
  removePendingCleanup,
  upsertManifestPlugin,
  type GitSource,
  type InstallRecord,
  type ManifestPluginEntry,
} from './manifestStore.js'
import type { RequestScope } from './scope.js'
import type { AdminDeps } from './admin.js'

/**
 * 自部署的管理端点：插件清单存 D1，构建机经 /admin/build-manifest 拉取，
 * /admin/builds 经 Builds REST API 触发 Workers Builds 重建。
 * 设计见 docs/design.md「单 Worker，触发构建」。
 */

// 这个文件是入口：安装 / 升级留在这里，其余几块各自一个文件，从这里统一导出（admin.ts、runtime.ts 只认这里）。
// buildMachine.ts 构建机端点 · installChecks.ts 安装校验 · buildTrigger.ts 触发构建 ·
// buildLedger.ts 账本同步 · uninstall.ts 卸载与收尾 · managedPlugins.ts 期望状态与线上对照
export { handleBuildConfig, handleBuildManifest, handleBuildReport } from './buildMachine.js'
export { DEPENDENCIES_MISSING, DO_MIGRATION_REQUIRED, dependentsOf, knownManifests } from './installChecks.js'
export { triggerBuild } from './buildTrigger.js'
export { listBuildsStatus, syncBuildLedgerOnSchedule } from './buildLedger.js'
export { processPendingCleanups, uninstallManifestPlugin } from './uninstall.js'
export { listManagedPlugins } from './managedPlugins.js'

// ---------- 安装 / 升级 ----------

/**
 * POST /admin/manifest/plugins  { source: "git:owner/repo@sha[#subdir]" }
 *
 * 可选参数，不传就是原来的行为：
 * - `dryRun: true`：只预检，不写 D1、不记账本、不构建；返回清单摘要、警告与 DO 提示，面板据此让人确认
 * - `build: false`：只写 D1 不触发构建。批量更新时逐个写进去，最后调一次 `POST /admin/builds`
 * - `acknowledgeDurableObjects: true`：**已废弃**。安装不再拦截 DO 插件（投影器自动声明 exports），
 *   这个参数照旧接受但已不起作用，留着是为了让老面板与老脚本不改也能继续工作
 */
export async function installManifestPlugin(request: Request, scope: RequestScope, deps: AdminDeps): Promise<Response> {
  const db = await requireDb(scope)
  if (!db) return error('未绑定 D1，无法安装插件', 503)

  const body = await readJson<{ source?: string; acknowledgeDurableObjects?: boolean; build?: boolean; dryRun?: boolean }>(request)
  const source = body?.source?.trim()
  if (!source) return error('需要 source，例如 git:owner/repo@a1b2c3d4e5', 400)

  if (body?.dryRun === true) {
    const preview = await previewInstall(source, scope, deps)
    if (!preview.ok) return error(preview.error, preview.status, preview.code)
    return json({ ok: true, dryRun: true, ...preview.preview })
  }

  // acknowledgeDurableObjects 已废弃：照旧把它读进来（老面板会传），但不再影响任何判断
  const out = await installFromSource(source, scope, deps)
  if (!out.ok) return error(out.error, out.status, out.code)

  // 就地触发构建：只改 D1 清单的话，插件根本不在正在运行的 bundle 里——装了等于没装。
  // 卸载与一键更新一直是这么做的，安装以前漏了，靠面板前端补发一次；
  // 于是 curl / 脚本装完什么都不会发生，账本留一条 pending 挂到 24h 后被收敛成失败。
  // 触发失败不回滚安装（清单已经改了，回滚只会更乱），如实报出来让用户重试构建。
  const build = body?.build === false ? BUILD_DEFERRED : await buildAfterChange(scope, deps, out.hash)
  return json({
    ok: true,
    plugin: out.plugin,
    ...(out.previous ? { previous: out.previous } : {}),
    hash: out.hash,
    install: out.install,
    build,
    ...(out.warnings.length > 0 ? { warnings: out.warnings } : {}),
  })
}

type InstallOutcome =
  | {
      ok: true
      plugin: ManifestPluginEntry
      previous?: { version: string; source: string }
      hash: string
      install: InstallRecord
      warnings: string[]
    }
  | Failure

/** dryRun：跑完全部校验，但什么都不写 */
async function previewInstall(
  source: string,
  scope: RequestScope,
  deps: AdminDeps,
): Promise<{ ok: true; preview: Record<string, unknown> } | Failure> {
  const inspected = await inspectSource(source, scope, deps)
  if (!inspected.ok) return inspected
  const blocked = blockingProblem(inspected, deps)
  if (blocked) return blocked
  const { entry, existing, declared, doNotice } = inspected
  const dependencies = await inspectDependencies(inspected.git, deps.options.fetchImpl)
  return {
    ok: true,
    preview: {
      plugin: entry,
      ...(existing ? { previous: { version: existing.version, source: existing.source } } : {}),
      manifest: summarizeManifest(declared),
      // 第三方依赖：构建时按插件仓库的 lockfile 安装、打进插件自己的 plugin.js。和权限一样让人确认
      dependencies: dependencies.packages,
      warnings: [...installWarnings(inspected, deps.registry), ...dependencyWarnings(dependencies)],
      // DO 不再拦截：`required` 恒为 false，message 只是「会随主模块求值、且没有版本预览地址」的告知。
      // 字段保留是为了让面板 UI 照旧能显示这条说明（老面板读 required 也拿不到阻断了）。
      durableObjects: doNotice ? { required: false, message: doNotice } : null,
    },
  }
}

/** 安装/升级一个 git 来源的插件：拉声明清单校验、冲突与依赖检查、写入 D1 并记一条 pending 账本 */
async function installFromSource(
  source: string,
  scope: RequestScope,
  deps: AdminDeps,
): Promise<InstallOutcome> {
  const inspected = await inspectSource(source, scope, deps)
  if (!inspected.ok) return inspected
  const blocked = blockingProblem(inspected, deps)
  if (blocked) return blocked

  const db = scope.env.DB!
  const { entry, existing, declared } = inspected
  const warnings = installWarnings(inspected, deps.registry)
  // DO 的说明从「拦下来要求改仓库」降级为提醒：投影器在模板没有 migrations 历史时
  // 自动产出声明式 exports，装 DO 插件不再需要人工介入（见 installChecks 的注释）。
  // 真走了老路径且缺项时，构建阶段会失败并把原因回报到面板。
  if (inspected.doNotice) warnings.unshift(inspected.doNotice)
  await upsertManifestPlugin(db, { ...entry, manifest: declared })
  // 卸载的后半段还没跑（旧部署还在）就又装回来：取消它，别让定时任务把新装的这份的数据清掉
  await removePendingCleanup(db, entry.name)
  const hash = await manifestHash(await listManifestPlugins(db))
  const install = await insertInstall(db, {
    action: existing ? 'upgrade' : 'install',
    name: entry.name,
    source,
    manifestHash: hash,
    status: 'pending',
  })
  return {
    ok: true,
    plugin: entry,
    ...(existing ? { previous: { version: existing.version, source: existing.source } } : {}),
    hash,
    install,
    warnings,
  }
}

/**
 * 从仓库的 commits.atom 解析默认分支最新 commit。
 * 不走匿名 GitHub API：Workers 共享出口 IP，60 次/小时的限额会被打爆；atom feed 宽松且无需鉴权。
 * 私有仓库的 atom 401——只支持公开仓库。
 */
export async function resolveLatestCommit(owner: string, repo: string, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl(`https://github.com/${owner}/${repo}/commits.atom`, { redirect: 'follow' })
  if (!res.ok) {
    throw new Error(`拉取 ${owner}/${repo} 的 commits.atom 失败（HTTP ${res.status}）：仓库不存在，或是私有仓库（只支持公开的 GitHub 仓库）`)
  }
  const xml = await res.text()
  const firstEntry = /<entry>[\s\S]*?<\/entry>/.exec(xml)?.[0] ?? ''
  const sha = /commit\/([0-9a-f]{40})<\/id>/i.exec(firstEntry)?.[1]
  if (!sha) throw new Error('commits.atom 里没有解析到 commit——仓库是空的？')
  return sha
}

/** 同一个仓库（连同子目录）钉到另一个 commit 的 source：`git:<owner>/<repo>@<sha>[#<子目录>]` */
function gitSourceAt(git: GitSource, sha: string): string {
  return `git:${git.owner}/${git.repo}@${sha}${git.subdir ? `#${git.subdir}` : ''}`
}

/** POST /admin/manifest/plugins/:name/check-update —— 解析上游最新 commit，只查不装 */
export async function checkPluginUpdate(name: string, scope: RequestScope, deps: AdminDeps): Promise<Response> {
  const db = await requireDb(scope)
  if (!db) return error('未绑定 D1，无法检查更新', 503)
  const existing = await getManifestPlugin(db, name)
  if (!existing) return error(`未安装或为仓库内置插件（内置插件请改仓库后重新构建）：${name}`, 404)
  const git = parseGitSource(existing.source)
  if (!git) return error(`来源不是 git 形式，无法自动检查更新：${existing.source}`, 400)

  let latestSha: string
  try {
    latestSha = await resolveLatestCommit(git.owner, git.repo, deps.options.fetchImpl)
  } catch (err) {
    return error((err as Error).message, 502)
  }
  const latestSource = gitSourceAt(git, latestSha)
  const upToDate = latestSha === git.sha
  let latestVersion: string | null = null
  // 批量更新前让人看见的两件事：新增的权限，以及新增的 DO 类（要先改仓库，不能直接勾上就更新）
  let newPermissions: string[] = []
  let newDurableObjects: string[] = []
  if (!upToDate) {
    const fetched = await fetchDeclaredManifest({ ...git, sha: latestSha }, deps.options.fetchImpl)
    if (fetched.ok) {
      const declared = fetched.manifest
      latestVersion = declared.version
      const records = await listManifestPluginRecords(db)
      const previous = previousManifest(name, records, deps.registry)
      newPermissions = (declared.permissions ?? []).filter((p) => !(previous?.permissions ?? []).includes(p))
      const knownDo = knownDurableObjects(name, records, deps.registry)
      newDurableObjects = (declared.durableObjects ?? []).filter((c) => !knownDo.has(c))
    }
  }
  return json({
    ok: true,
    name,
    current: existing.source,
    currentVersion: existing.version,
    latestSha,
    latestVersion,
    upToDate,
    latestSource,
    newPermissions,
    newDurableObjects,
  })
}

/** POST /admin/manifest/plugins/:name/update —— 升级到上游最新 commit 并自动触发构建 */
export async function updatePlugin(name: string, scope: RequestScope, deps: AdminDeps): Promise<Response> {
  const db = await requireDb(scope)
  if (!db) return error('未绑定 D1，无法更新插件', 503)
  const existing = await getManifestPlugin(db, name)
  if (!existing) return error(`未安装或为仓库内置插件（内置插件请改仓库后重新构建）：${name}`, 404)
  const git = parseGitSource(existing.source)
  if (!git) return error(`来源不是 git 形式，无法自动更新：${existing.source}`, 400)

  let latestSha: string
  try {
    latestSha = await resolveLatestCommit(git.owner, git.repo, deps.options.fetchImpl)
  } catch (err) {
    return error((err as Error).message, 502)
  }
  if (latestSha === git.sha) return json({ ok: true, name, upToDate: true, current: existing.source })

  const latestSource = gitSourceAt(git, latestSha)
  const outcome = await installFromSource(latestSource, scope, deps)
  if (!outcome.ok) return error(outcome.error, outcome.status, outcome.code)

  // 就地触发构建：换钉子之后不构建，新版永远不会上线
  const build = await buildAfterChange(scope, deps, outcome.hash)
  return json({
    ok: true,
    name,
    upToDate: false,
    previous: { version: existing.version, source: existing.source },
    latestSource,
    plugin: outcome.plugin,
    install: outcome.install,
    build,
    ...(outcome.warnings.length > 0 ? { warnings: outcome.warnings } : {}),
  })
}
