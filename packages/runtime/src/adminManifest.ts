import { BUILD_COMMAND, CloudflareBuildsApi, DEPLOY_COMMAND, doExportName, suggestMigrationTag, type BuildRecord } from '@qqbot/projector'
import { validateManifest, type Manifest } from '@qqbot/sdk'
import { authenticate, bearerOf } from './auth.js'
import { error, json, readJson } from './http.js'
import {
  deleteManifestPlugin,
  getManifestPlugin,
  insertInstall,
  listInstalls,
  listManifestPlugins,
  manifestHash,
  markPendingBuilding,
  parseGitSource,
  rawManifestUrl,
  updateInstallById,
  updateInstallByBuildUuid,
  upsertManifestPlugin,
  type InstallRecord,
  type ManifestPluginEntry,
} from './manifestStore.js'
import { clearInstallMarker, purgePluginData, runUninstallHook } from './purge.js'
import { prefixesCollide, tablePrefix } from './sqlScope.js'
import { Keys } from './store.js'
import type { RequestScope } from './scope.js'
import type { AdminDeps } from './admin.js'

/**
 * 自部署的管理端点：插件清单存 D1，构建机经 /admin/build-manifest 拉取，
 * /admin/builds 经 Builds REST API 触发 Workers Builds 重建。
 * 设计见 docs/design.md「单 Worker，触发构建」。
 */

async function requireDb(scope: RequestScope): Promise<D1Database | null> {
  if (!scope.env.DB) return null
  return scope.env.DB
}

/** 构建机拉清单：配置了 BUILD_TOKEN 用它，否则与管理 API 同一鉴权（ADMIN_TOKEN/会话令牌） */
export async function handleBuildManifest(request: Request, scope: RequestScope): Promise<Response> {
  const buildToken = scope.env.BUILD_TOKEN
  const bearer = bearerOf(request)
  const viaBuildToken = !!buildToken && bearer === buildToken
  if (!viaBuildToken && !(await authenticate(request, scope.env.ADMIN_TOKEN)).admin) return error('未授权', 401)

  const db = await requireDb(scope)
  if (!db) return error('未绑定 D1（wrangler.jsonc 的 d1_databases），构建清单不可用', 503)
  const plugins = await listManifestPlugins(db)
  const hash = await manifestHash(plugins)
  // 触发这次构建的账本记录（推送触发的构建没有对应记录，返回 null）。构建机据此对照
  // 「触发时的清单」与「实际构建的清单」——不一致只告警、不阻断：并发装两个插件本来就会这样，
  // 收敛到最新是设计语义，把它做成构建失败只会让正常操作无故炸掉。
  const pending = (await listInstalls(db, 20)).find((r) => r.status === 'building' || r.status === 'pending')
  return json({
    ok: true,
    hash,
    plugins,
    pendingBuild: pending
      ? { buildUuid: pending.buildUuid, hash: pending.manifestHash, triggeredAt: pending.ts }
      : null,
    generatedAt: new Date().toISOString(),
  })
}

/** 构建机拉配置：拉取当前 Worker 的基础设施绑定标识（KV ID, D1 ID 等） */
export async function handleBuildConfig(request: Request, scope: RequestScope): Promise<Response> {
  const buildToken = scope.env.BUILD_TOKEN
  const bearer = bearerOf(request)
  const viaBuildToken = !!buildToken && bearer === buildToken
  if (!viaBuildToken && !(await authenticate(request, scope.env.ADMIN_TOKEN)).admin) return error('未授权', 401)

  return json({
    ok: true,
    bindings: {
      workerName:
        typeof scope.env.CF_WORKER_NAME === 'string' && scope.env.CF_WORKER_NAME.length > 0
          ? scope.env.CF_WORKER_NAME
          : (typeof scope.env.WORKER_NAME === 'string' && scope.env.WORKER_NAME.length > 0 ? scope.env.WORKER_NAME : null),
      kvId: typeof scope.env.CF_KV_ID === 'string' && scope.env.CF_KV_ID.length > 0 ? scope.env.CF_KV_ID : null,
      d1Id: typeof scope.env.CF_D1_ID === 'string' && scope.env.CF_D1_ID.length > 0 ? scope.env.CF_D1_ID : null,
      r2Name: typeof scope.env.CF_R2_NAME === 'string' && scope.env.CF_R2_NAME.length > 0 ? scope.env.CF_R2_NAME : null,
      domain: typeof scope.env.CF_CUSTOM_DOMAIN === 'string' && scope.env.CF_CUSTOM_DOMAIN.length > 0 ? scope.env.CF_CUSTOM_DOMAIN : null,
      defaultDomain:
        typeof scope.env.CF_DEFAULT_DOMAIN === 'string' && scope.env.CF_DEFAULT_DOMAIN.length > 0
          ? scope.env.CF_DEFAULT_DOMAIN
          : null,
      // 上面那些 CF_* 是「构建机填绑定要用的 id」，回答不了「这次部署到底绑没绑上」——
      // secret 没写但资源确实绑着是很常见的状态。构建机靠这两个字段区分
      // 「面板连不上」与「真的没有 D1」，拿 id 的有无去猜会把前者误判成后者，
      // 于是清单拉不到时静默放行，D1 里装的插件全部从 Worker 上消失。
      hasD1: !!scope.env.DB,
      hasR2: !!scope.env.R2,
    },
    generatedAt: new Date().toISOString(),
  })
}

/** 声明清单：root 的 manifest.json 优先，dist/manifest.json 兜底（旧仓库布局） */
async function fetchDeclaredManifest(
  git: NonNullable<ReturnType<typeof parseGitSource>>,
  fetchImpl: typeof fetch,
): Promise<Manifest | string> {
  const urls = [rawManifestUrl(git), rawManifestUrl(git, true)]
  for (const url of urls) {
    let res: Response
    try {
      res = await fetchImpl(url, { redirect: 'follow' })
    } catch (err) {
      return `拉取声明清单失败：${err instanceof Error ? err.message : String(err)}`
    }
    if (res.status === 404) continue
    if (!res.ok) return `拉取声明清单失败：HTTP ${res.status} ${url}`
    let manifest: Manifest
    try {
      manifest = JSON.parse(await res.text()) as Manifest
    } catch {
      return `声明清单不是合法 JSON：${url}`
    }
    if (typeof manifest !== 'object' || manifest === null || typeof manifest.name !== 'string') {
      return `声明清单缺少 name 字段：${url}`
    }
    return manifest
  }
  return '插件源里没有声明清单（manifest.json）——请在插件仓库运行 qqbot-plugin build，并把生成的 manifest.json 提交到仓库根目录'
}

/** POST /admin/manifest/plugins  { source: "git:owner/repo@sha[#subdir]" } */
export async function installManifestPlugin(request: Request, scope: RequestScope, deps: AdminDeps): Promise<Response> {
  const db = await requireDb(scope)
  if (!db) return error('未绑定 D1，无法安装插件', 503)

  const body = await readJson<{ source?: string; acknowledgeDurableObjects?: boolean }>(request)
  const source = body?.source?.trim()
  if (!source) return error('需要 source，例如 git:owner/repo@a1b2c3d4e5', 400)
  const out = await installFromSource(source, scope, deps, {
    acknowledgeDurableObjects: body?.acknowledgeDurableObjects === true,
  })
  if (!out.ok) return error(out.error, out.status, out.code)

  // 就地触发构建：只改 D1 清单的话，插件根本不在正在运行的 bundle 里——装了等于没装。
  // 卸载与一键更新一直是这么做的，安装以前漏了，靠面板前端补发一次；
  // 于是 curl / 脚本装完什么都不会发生，账本留一条 pending 挂到 24h 后被收敛成失败。
  // 触发失败不回滚安装（清单已经改了，回滚只会更乱），如实报出来让用户重试构建。
  const build = await triggerProjectionBuild(scope, deps)
  return json({
    ok: true,
    plugin: out.plugin,
    ...(out.previous ? { previous: out.previous } : {}),
    hash: out.hash,
    install: out.install,
    build: build.ok ? { buildUuid: build.buildUuid } : { error: build.error },
  })
}

type InstallOutcome =
  | { ok: true; plugin: ManifestPluginEntry; previous?: { version: string }; hash: string; install: InstallRecord }
  | { ok: false; error: string; status: number; code?: string }

/** 声明了 DO 类、但还没确认仓库 migrations 已就位——面板据此给出「我已加好」的确认入口 */
export const DO_MIGRATION_REQUIRED = 'durable_objects_migration_required'

/**
 * 声明了 Durable Object 的插件，装进来之前必须先往仓库的 wrangler.jsonc 补一条 migrations。
 *
 * 为什么非拦不可：migrations 是只追加的历史，平台靠「上次应用过的 tag」算增量，构建机没有
 * 这个持久状态、造不出正确的历史，所以 projector 选择了校验而不是合成（见 checkDoMigrations）。
 * 校验发生在 prepare 阶段——也就是说插件已经写进 D1 之后才炸，而且是**每一次**构建都炸，
 * 包括之后装别的插件、一键更新、卸载以外的任何操作，直到有人想到把它卸载。
 * 构建日志还没内嵌进面板，用户在面板上只看得到一个「失败」。
 *
 * 运行时读不到仓库里的 wrangler.jsonc（它不在 bundle 里），没法判断那条 migrations 是否
 * 已经加好，所以只能拦下来把要加的内容原样给出，由用户确认后带 acknowledgeDurableObjects 重装。
 */
function checkDurableObjectsDeclared(declared: Manifest, acknowledged: boolean): InstallOutcome | null {
  const classes = declared.durableObjects ?? []
  if (classes.length === 0 || acknowledged) return null
  const exportNames = classes.map((c) => doExportName(declared.name, c))
  const tag = suggestMigrationTag(new Set<string>(), exportNames)
  return {
    ok: false,
    status: 409,
    code: DO_MIGRATION_REQUIRED,
    error:
      `${declared.name} 声明了 Durable Object 类（${classes.join('、')}），装进来之前需要先改仓库。\n` +
      'DO 的 migrations 是只追加的历史，平台靠「上次应用过的 tag」算增量，构建机没有这个状态、造不出来。\n' +
      '请在 apps/seed/wrangler.jsonc 的 migrations 末尾追加一项并提交（tag 不能与已有重复）：\n' +
      `  { "tag": "${tag}", "new_sqlite_classes": [${exportNames.map((n) => `"${n}"`).join(', ')}] }\n` +
      '不加就装的话，之后每一次构建都会失败（包括装别的插件），直到把它卸载。\n' +
      '已经加好并推送了？确认后重新安装即可。',
  }
}

/** 安装/升级一个 git 来源的插件：拉声明清单校验、冲突与依赖检查、写入 D1 并记一条 pending 账本 */
async function installFromSource(
  source: string,
  scope: RequestScope,
  deps: AdminDeps,
  opts: { acknowledgeDurableObjects?: boolean } = {},
): Promise<InstallOutcome> {
  const db = await requireDb(scope)
  if (!db) return { ok: false, error: '未绑定 D1，无法安装插件', status: 503 }

  const git = parseGitSource(source)
  if (!git) return { ok: false, error: `source 需为 git:<owner>/<repo>@<commit>[#<子目录>] 格式：${source}`, status: 400 }

  const declared = await fetchDeclaredManifest(git, deps.options.fetchImpl)
  if (typeof declared === 'string') return { ok: false, error: declared, status: 400 }
  const problems = validateManifest(declared)
  if (problems.length > 0) return { ok: false, error: `声明清单非法：${problems.join('；')}`, status: 400 }

  const doBlocked = checkDurableObjectsDeclared(declared, opts.acknowledgeDurableObjects === true)
  if (doBlocked) return doBlocked

  const installed = await listManifestPlugins(db)
  const registryNames = new Set(deps.registry.all().map((p) => p.manifest.name))
  const allNames = new Set<string>([...installed.map((p) => p.name), ...registryNames])

  const conflict = (declared.conflicts ?? []).find((c) => allNames.has(c))
  if (conflict) return { ok: false, error: `安装 ${declared.name} 与已装插件冲突：${declared.name} conflicts ${conflict}`, status: 409 }

  // D1 表前缀不是单射：`my-plugin` 与 `my_plugin` 都落到 p_my_plugin_，卸载一个会连带删掉另一个的表。
  // 装进来就晚了（DROP 不可逆），所以在安装这一步就挡住。
  const prefixClash = [...allNames].find((n) => prefixesCollide(n, declared.name))
  if (prefixClash) {
    return {
      ok: false,
      status: 409,
      error:
        `${declared.name} 与已装插件 ${prefixClash} 的 D1 表前缀相同（${tablePrefix(declared.name)}）——` +
        '两者不能共存：卸载其中一个会连带删掉另一个的表，且不可逆。请把插件名里的 `-` 改成 `_`（或反过来）后重装。',
    }
  }

  const missingDeps = Object.keys(declared.depends ?? {}).filter((d) => !allNames.has(d) && !deps.registry.providerOf(d))
  if (missingDeps.length > 0) {
    return { ok: false, error: `依赖未满足：${missingDeps.join('、')}（需先安装提供者，或由内置插件提供该服务）`, status: 400 }
  }

  const existing = installed.find((p) => p.name === declared.name)
  const entry: ManifestPluginEntry = { name: declared.name, version: declared.version, source }
  await upsertManifestPlugin(db, entry)
  const hash = await manifestHash(await listManifestPlugins(db))
  const install = await insertInstall(db, {
    action: existing ? 'upgrade' : 'install',
    name: entry.name,
    source,
    manifestHash: hash,
    status: 'pending',
  })
  return { ok: true, plugin: entry, ...(existing ? { previous: { version: existing.version } } : {}), hash, install }
}

/**
 * 从仓库的 commits.atom 解析默认分支最新 commit。
 * 不走匿名 GitHub API：Workers 共享出口 IP，60 次/小时的限额会被打爆；atom feed 宽松且无需鉴权。
 * 私有仓库的 atom 401，只能手贴 git: 链接。
 */
export async function resolveLatestCommit(owner: string, repo: string, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl(`https://github.com/${owner}/${repo}/commits.atom`, { redirect: 'follow' })
  if (!res.ok) {
    throw new Error(`拉取 ${owner}/${repo} 的 commits.atom 失败（HTTP ${res.status}）。私有仓库不支持自动检查更新，请直接粘贴 git:owner/repo@commit`)
  }
  const xml = await res.text()
  const firstEntry = /<entry>[\s\S]*?<\/entry>/.exec(xml)?.[0] ?? ''
  const sha = /commit\/([0-9a-f]{40})<\/id>/i.exec(firstEntry)?.[1]
  if (!sha) throw new Error('commits.atom 里没有解析到 commit——仓库是空的？')
  return sha
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
  const latestSource = `git:${git.owner}/${git.repo}@${latestSha}${git.subdir ? `#${git.subdir}` : ''}`
  const upToDate = latestSha === git.sha
  let latestVersion: string | null = null
  if (!upToDate) {
    const declared = await fetchDeclaredManifest({ ...git, sha: latestSha }, deps.options.fetchImpl)
    if (typeof declared !== 'string') latestVersion = declared.version
  }
  return json({ ok: true, name, current: existing.source, latestSha, latestVersion, upToDate, latestSource })
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

  const latestSource = `git:${git.owner}/${git.repo}@${latestSha}${git.subdir ? `#${git.subdir}` : ''}`
  const outcome = await installFromSource(latestSource, scope, deps)
  if (!outcome.ok) return error(outcome.error, outcome.status, outcome.code)

  // 就地触发构建：换钉子之后不构建，新版永远不会上线
  const build = await triggerProjectionBuild(scope, deps)
  return json({
    ok: true,
    name,
    upToDate: false,
    previous: { version: existing.version, source: existing.source },
    latestSource,
    plugin: outcome.plugin,
    install: outcome.install,
    build: build.ok ? { buildUuid: build.buildUuid } : { error: build.error },
  })
}

/**
 * DELETE /admin/manifest/plugins/:name[?purge=true]
 *
 * 数据默认**保留**：卸载多半是不想要了，但误删不可逆，而留下的数据在
 * `GET /admin/storage` 里会被标成孤儿，随时可以清——比默认删安全，又不至于管不了。
 */
export async function uninstallManifestPlugin(
  name: string,
  purgeData: boolean,
  scope: RequestScope,
  deps: AdminDeps,
): Promise<Response> {
  const db = await requireDb(scope)
  if (!db) return error('未绑定 D1，无法卸载插件', 503)

  const existing = await getManifestPlugin(db, name)
  if (!existing) {
    const bundled = deps.registry.get(name)
    return error(bundled ? '该插件由仓库清单内置：请从 qqbot.manifest.json 移除后重新构建' : `未安装：${name}`, 404)
  }

  // 趁插件代码还在这次部署里，先让它自己收尾；重建之后就没机会了
  const registered = deps.registry.get(name)
  const { hook, hookError } = registered
    ? await runUninstallHook(registered, scope.contexts, purgeData, deps.logger)
    : { hook: 'none' as const, hookError: undefined }

  // 把其他已知插件名一并交给清理逻辑：D1 表前缀可能碰撞（`my-plugin` vs `my_plugin`），
  // 没有这份名单就无法判断某张表到底属于谁，宁可留孤儿也不能误删邻居
  const otherNames = [
    ...new Set([
      ...deps.registry.all().map((p) => p.manifest.name),
      ...(await listManifestPlugins(db)).map((p) => p.name),
    ]),
  ]
  const purged = purgeData ? await purgePluginData(name, scope.env, otherNames) : null
  await clearInstallMarker(name, scope.env)

  await deleteManifestPlugin(db, name)
  const hash = await manifestHash(await listManifestPlugins(db))
  const install = await insertInstall(db, { action: 'uninstall', name, source: existing.source, manifestHash: hash, status: 'pending' })

  // 就地触发构建：只改 D1 清单的话，插件还留在正在运行的 bundle 里——卸载等于没生效。
  // 触发失败不回滚卸载（清单已经改了，回滚只会更乱），如实报出来让用户手动重试。
  const build = await triggerProjectionBuild(scope, deps)

  return json({
    ok: true,
    removed: existing,
    hash,
    install,
    build: build.ok ? { buildUuid: build.buildUuid } : { error: build.error },
    data: { purged: purgeData, hook, ...(hookError ? { hookError } : {}), ...(purged ?? {}) },
  })
}

function buildsApi(scope: RequestScope, deps: AdminDeps): CloudflareBuildsApi | null {
  const { CF_ACCOUNT_ID, CF_BUILDS_TOKEN } = scope.env
  if (!CF_ACCOUNT_ID || !CF_BUILDS_TOKEN) return null
  return new CloudflareBuildsApi({ accountId: CF_ACCOUNT_ID, apiToken: CF_BUILDS_TOKEN, fetchImpl: deps.options.fetchImpl })
}

/** Builds API 的"完成与否"在 build_outcome（success/fail/skipped/cancelled/terminated），
 * status 只有 queued/initializing/running/stopped——只看 status 会把完成的构建永远当"构建中"。
 */
function buildToInstallState(build: BuildRecord): { status: InstallRecord['status']; cfStatus: string | null } {
  const outcome = build.build_outcome
  if (outcome === 'success') return { status: 'ok', cfStatus: 'success' }
  if (outcome) return { status: 'failed', cfStatus: outcome }
  return { status: 'building', cfStatus: build.status ?? null }
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
 * 把构建命令与清单环境变量写进 trigger。
 *
 * 网页向导在用户连完仓库时就写好了；这条路径是给**无 UI 引导**和「后来重连过仓库」兜底的——
 * 那两种情况下引导跑完时 trigger 还不存在，写不了，用户就只能照 Summary 手抄四项。
 * 而这四项里最容易配错的恰好是 MANIFEST_TOKEN 与 Worker 侧 BUILD_TOKEN 的对齐，
 * 两个值本来就在同一个 env 里，没有理由让人肉搬运。
 *
 * 只写一次（KV 打标），避免覆盖用户后来在后台的手动调整；失败只记日志不阻断触发构建。
 */
async function ensureTriggerConfigured(
  api: CloudflareBuildsApi,
  triggerUuid: string,
  scope: RequestScope,
  deps: AdminDeps,
): Promise<void> {
  const domain = scope.env.CF_DEFAULT_DOMAIN || scope.env.CF_CUSTOM_DOMAIN
  // 拿不到自己的对外地址就别乱写——写进去一个错的 MANIFEST_URL 比不写更难查
  if (!domain || !scope.env.BUILD_TOKEN) return
  try {
    if (await scope.env.KV.get(Keys.cfTriggerConfigured)) return
    await api.updateTrigger(triggerUuid, { build_command: BUILD_COMMAND, deploy_command: DEPLOY_COMMAND })
    await api.putTriggerEnv(triggerUuid, {
      MANIFEST_URL: { value: `https://${domain}/admin/build-manifest`, is_secret: false },
      MANIFEST_TOKEN: { value: scope.env.BUILD_TOKEN, is_secret: true },
    })
    await scope.env.KV.put(Keys.cfTriggerConfigured, new Date().toISOString())
    deps.logger.info('已写入构建 trigger 配置（构建命令与清单环境变量）')
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
async function resolveBuildTargets(scope: RequestScope, deps: AdminDeps): Promise<BuildTargets | null> {
  const { CF_WORKER_TAG, CF_TRIGGER_UUID } = scope.env
  const api = buildsApi(scope, deps)
  // 目标写死在 env 里也要补构建配置——写死的是「哪个 trigger」，不是「trigger 里配了什么」
  if (CF_WORKER_TAG && CF_TRIGGER_UUID) {
    if (api) await ensureTriggerConfigured(api, CF_TRIGGER_UUID, scope, deps)
    return { workerTag: CF_WORKER_TAG, triggerUuid: CF_TRIGGER_UUID }
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
  await ensureTriggerConfigured(api, targets.triggerUuid, scope, deps)
  return targets
}

/** 触发一次 Workers Build 重建当前清单；build 端点与插件一键更新共用 */
async function triggerProjectionBuild(
  scope: RequestScope,
  deps: AdminDeps,
  branch?: string,
): Promise<{ ok: true; buildUuid: string; branch: string; hash: string; install: InstallRecord } | { ok: false; error: string; status: number }> {
  const env = scope.env
  if (!env.CF_ACCOUNT_ID || !env.CF_BUILDS_TOKEN) {
    return { ok: false, status: 503, error: '自部署未配置：缺少 CF_ACCOUNT_ID / CF_BUILDS_TOKEN（设置步骤见 seed README）' }
  }
  const db = await requireDb(scope)
  if (!db) return { ok: false, status: 503, error: '未绑定 D1，无法记录构建' }

  const hash = await manifestHash(await listManifestPlugins(db))
  const api = buildsApi(scope, deps)
  if (!api) return { ok: false, status: 503, error: '自部署未配置：缺少 CF_ACCOUNT_ID / CF_BUILDS_TOKEN' }
  const branchName = branch ?? env.CF_BUILD_BRANCH ?? 'main'

  let targets: BuildTargets | null = null
  try {
    targets = await resolveBuildTargets(scope, deps)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, status: 502, error: `确定构建目标失败：${message}` }
  }
  if (!targets) return { ok: false, status: 503, error: '自部署未配置：缺少 CF_ACCOUNT_ID / CF_BUILDS_TOKEN' }

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
      return { ok: false, status: 502, error: `触发构建失败：${firstError}` }
    }
    try {
      ;({ buildUuid } = await api.triggerBuild(refreshed.triggerUuid, { branch: branchName }))
    } catch (err2) {
      const message = err2 instanceof Error ? err2.message : String(err2)
      await insertInstall(db, { action: 'build', name: null, source: null, manifestHash: hash, status: 'failed', error: message })
      return { ok: false, status: 502, error: `触发构建失败：${message}` }
    }
  }

  await markPendingBuilding(db, hash, buildUuid)
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

/**
 * 把账本里还在进行中的记录与 Cloudflare 的构建状态对齐，并收敛卡死的记录。
 *
 * 面板打开时调一次，Cron 也调（见 syncBuildLedgerOnSchedule）——只靠面板的话，
 * 装完插件关掉页面账本就永远停在「构建中」，24h 后还会被卡死收敛误标成失败。
 *
 * 返回同步失败的原因（成功为 null）；rows 会被就地更新成最新状态。
 */
async function syncBuildLedger(
  db: D1Database,
  rows: InstallRecord[],
  scope: RequestScope,
  deps: AdminDeps,
): Promise<string | null> {
  const api = buildsApi(scope, deps)
  let syncError: string | null = null
  let byUuid: Map<string, BuildRecord> | null = null
  const hasInFlight = rows.some((r) => r.buildUuid && (r.status === 'building' || r.status === 'pending'))
  if (!api) {
    // 装过插件但没有 Builds 凭据：状态永远同步不了，如实告知
    if (rows.some((r) => r.status === 'building' || r.status === 'pending')) {
      syncError = '未配置 CF_ACCOUNT_ID / CF_BUILDS_TOKEN，无法同步构建状态'
    }
  } else if (hasInFlight) {
    let workerTag: string | null = null
    try {
      workerTag = (await resolveBuildTargets(scope, deps))?.workerTag ?? null
    } catch (err) {
      syncError = err instanceof Error ? err.message : String(err)
    }
    if (workerTag && !syncError) {
      try {
        const builds = await api.listBuilds(workerTag)
        byUuid = new Map(builds.filter((b) => b.build_uuid).map((b) => [b.build_uuid!, b]))
      } catch (err) {
        // 同步失败必须可见，否则账本会永远停在"构建中"（例如 CF_WORKER_TAG 填成了 worker 名字）
        syncError = err instanceof Error ? err.message : String(err)
        deps.logger.warn('构建状态同步失败', { error: syncError })
      }
    } else if (!syncError) {
      syncError = '无法确定构建目标，构建状态未同步'
    }
  }

  if (byUuid) {
    for (const row of rows) {
      if (!row.buildUuid || (row.status !== 'building' && row.status !== 'pending')) continue
      const build = byUuid.get(row.buildUuid)
      if (!build) continue
      const { status: next, cfStatus } = buildToInstallState(build)
      const commitHash = build.build_trigger_metadata?.commit_hash ?? null
      if (next !== row.status || (cfStatus && cfStatus !== row.cfStatus) || (commitHash && commitHash !== row.commitHash)) {
        await updateInstallByBuildUuid(db, row.buildUuid, {
          status: next,
          cfStatus,
          commitHash,
          ...(next === 'failed' ? { error: `构建未成功：${cfStatus}` } : {}),
        })
        row.status = next
        row.cfStatus = cfStatus
        row.commitHash = commitHash
      }
    }
    // 构建列表里找不到的 in-flight 记录：超过 30 分钟仍不出现即收敛
    const NOT_FOUND_MS = 30 * 60 * 1000
    for (const row of rows) {
      if (!row.buildUuid || (row.status !== 'building' && row.status !== 'pending')) continue
      if (!byUuid.has(row.buildUuid) && Date.now() - row.ts > NOT_FOUND_MS) {
        const message =
          'Cloudflare 构建列表中找不到该构建：可能已超出 Builds API 的返回范围（构建太多），' +
          '也可能是配置了 CF_WORKER_TAG 但填成了 worker 名字（应填 workers/scripts 返回的 tag）'
        await updateInstallByBuildUuid(db, row.buildUuid, { status: 'failed', cfStatus: 'not_found', error: message })
        row.status = 'failed'
        row.cfStatus = 'not_found'
        row.error = message
      }
    }
  }

  // 卡死收敛：超过 24h 仍是非终态的记录按失败处理，避免账本永远"构建中"（实际结果未知）
  const STALE_MS = 24 * 60 * 60 * 1000
  for (const row of rows) {
    if ((row.status === 'building' || row.status === 'pending') && Date.now() - row.ts > STALE_MS) {
      const message = '构建状态超过 24h 未同步，已按失败处理（实际结果未知）'
      if (row.buildUuid) await updateInstallByBuildUuid(db, row.buildUuid, { status: 'failed', error: message })
      else await updateInstallById(db, row.id, { status: 'failed', error: message })
      row.status = 'failed'
      row.error = message
    }
  }

  return syncError
}

/** 两次自动同步之间的最短间隔：cron 每分钟都会来，构建通常跑几分钟，没必要每分钟问一次 */
const LEDGER_SYNC_INTERVAL_MS = 3 * 60 * 1000

/**
 * Cron 里的账本同步。只有账本里真有进行中的记录才会走到网络，
 * 并用 KV 时间戳节流——否则每分钟一次 cron 会把 Builds API 打成 1440 次/天。
 */
export async function syncBuildLedgerOnSchedule(scope: RequestScope, deps: AdminDeps): Promise<void> {
  const db = scope.env.DB
  if (!db) return
  try {
    const rows = await listInstalls(db, 50)
    if (!rows.some((r) => r.status === 'building' || r.status === 'pending')) return

    const last = Number((await scope.env.KV.get(Keys.cfLedgerSyncedAt)) ?? 0)
    if (Number.isFinite(last) && Date.now() - last < LEDGER_SYNC_INTERVAL_MS) return
    await scope.env.KV.put(Keys.cfLedgerSyncedAt, String(Date.now()))

    const syncError = await syncBuildLedger(db, rows, scope, deps)
    if (syncError) deps.logger.warn('定时同步构建状态未完成', { error: syncError })
  } catch (err) {
    deps.logger.warn('定时同步构建状态失败', { error: err instanceof Error ? err.message : String(err) })
  }
}

/** GET /admin/builds —— 安装/构建账本；配置了 CF_* 时顺带同步进行中构建的状态与 commit */
export async function listBuildsStatus(scope: RequestScope, deps: AdminDeps): Promise<Response> {
  const db = await requireDb(scope)
  if (!db) return error('未绑定 D1，无安装记录', 503)
  const rows = await listInstalls(db, 50)
  const syncError = await syncBuildLedger(db, rows, scope, deps)
  return json({ ok: true, builds: rows, ...(syncError ? { syncError } : {}) })
}
