import {
  BUILD_COMMAND,
  CloudflareBuildsApi,
  DEPLOY_COMMAND,
  doExportName,
  productionBranchOf,
  suggestMigrationTag,
  type BuildRecord,
} from '@qqbot/projector'
import { commandKey, validateManifest, type Manifest } from '@qqbot/sdk'
import { authenticate, bearerOf } from './auth.js'
import { error, json, readJson } from './http.js'
import {
  addPendingCleanup,
  attachBuildError,
  clearPluginBuildErrors,
  deleteManifestPlugin,
  getManifestPlugin,
  insertInstall,
  listInstalls,
  listManifestPluginRecords,
  listManifestPlugins,
  listPendingCleanups,
  manifestHash,
  markPendingBuilding,
  parseGitSource,
  rawManifestUrl,
  rawPluginFileUrl,
  removePendingCleanup,
  sameGitRepo,
  setPluginBuildError,
  settlePendingInstalls,
  updateInstallById,
  updateInstallByBuildUuid,
  upsertManifestPlugin,
  type GitSource,
  type InstallRecord,
  type ManifestPluginEntry,
  type ManifestPluginRecord,
} from './manifestStore.js'
import { clearInstallMarker, purgePluginData, runUninstallHook } from './purge.js'
import type { PluginRegistry } from './registry.js'
import { prefixesCollide, tablePrefix } from './sqlScope.js'
import { Keys, readSnapshot, writeSnapshot } from './store.js'
import type { RequestScope } from './scope.js'
import type { AdminDeps } from './admin.js'
import type { RuntimeEnv } from './types.js'

/**
 * 自部署的管理端点：插件清单存 D1，构建机经 /admin/build-manifest 拉取，
 * /admin/builds 经 Builds REST API 触发 Workers Builds 重建。
 * 设计见 docs/design.md「单 Worker，触发构建」。
 */

async function requireDb(scope: RequestScope): Promise<D1Database | null> {
  if (!scope.env.DB) return null
  return scope.env.DB
}

/** 构建机的鉴权：配置了 BUILD_TOKEN 用它，否则与管理 API 同一鉴权（ADMIN_TOKEN/会话令牌） */
async function authorizeBuildMachine(request: Request, scope: RequestScope): Promise<boolean> {
  const buildToken = scope.env.BUILD_TOKEN
  if (buildToken && bearerOf(request) === buildToken) return true
  return (await authenticate(request, scope.env.ADMIN_TOKEN)).admin
}

/**
 * 构建机拉清单：配置了 BUILD_TOKEN 用它，否则与管理 API 同一鉴权（ADMIN_TOKEN/会话令牌）。
 *
 * 构建机会带上 `x-build-uuid`（Workers Builds 注入的 WORKERS_CI_BUILD_UUID），据此精确对上触发这次构建的
 * 账本记录；没带的（老构建脚本）退回「最近一条进行中的记录」。
 */
export async function handleBuildManifest(request: Request, scope: RequestScope): Promise<Response> {
  if (!(await authorizeBuildMachine(request, scope))) return error('未授权', 401)

  const db = await requireDb(scope)
  if (!db) return error('未绑定 D1（wrangler.jsonc 的 d1_databases），构建清单不可用', 503)
  const plugins = await listManifestPlugins(db)
  const hash = await manifestHash(plugins)
  // 触发这次构建的账本记录（推送触发的构建没有对应记录，返回 null）。构建机据此对照
  // 「触发时的清单」与「实际构建的清单」——不一致只告警、不阻断：并发装两个插件本来就会这样，
  // 收敛到最新是设计语义，把它做成构建失败只会让正常操作无故炸掉。
  const recent = await listInstalls(db, 50)
  const buildUuid = request.headers.get('x-build-uuid')?.trim()
  const pending = buildUuid
    ? recent.find((r) => r.action === 'build' && r.buildUuid === buildUuid)
    : recent.find((r) => r.status === 'building' || r.status === 'pending')
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
  if (!(await authorizeBuildMachine(request, scope))) return error('未授权', 401)

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

/** 回报里单条错误的长度上限：够看清原因，又不至于让一整段编译日志塞进账本 */
const REPORT_TEXT_LIMIT = 2000

function clipText(text: string, limit = REPORT_TEXT_LIMIT): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim())?.trim() ?? text
}

interface ReportedFailure {
  name: string
  source: string
  error: string
}

function isReportedFailure(value: unknown): value is ReportedFailure {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.name === 'string' && typeof v.source === 'string' && typeof v.error === 'string'
}

/**
 * POST /admin/build-report —— 构建机回报失败原因：哪个插件、哪个来源、什么错误。
 *
 * 构建失败时线上保留上一次成功的版本，这是故意的；但面板上以前只看得到一个「失败」，分不清是哪个插件坏了、
 * 该卸载哪个。构建机现在把每个插件都试着编一遍，失败的逐个报回来：错误记在 D1 条目上（只记在 source
 * 还没变的那一条），也记到这次构建的账本记录上。**只写错误信息，不改清单**——卸不卸由人决定。
 *
 * body: { buildUuid?, phase: 'prepare' | 'deploy', failures?: [{ name, source, error }], error? }
 */
export async function handleBuildReport(request: Request, scope: RequestScope): Promise<Response> {
  if (!(await authorizeBuildMachine(request, scope))) return error('未授权', 401)
  const db = await requireDb(scope)
  if (!db) return error('未绑定 D1，无处记录构建结果', 503)

  const body = await readJson<{ buildUuid?: unknown; phase?: unknown; failures?: unknown; error?: unknown }>(request)
  if (!body) return error('请求体格式错误', 400)
  const buildUuid = typeof body.buildUuid === 'string' && body.buildUuid.trim() ? body.buildUuid.trim() : null
  const phase = body.phase === 'deploy' ? 'deploy' : 'prepare'
  // 每条失败一次 D1 写入：免费版一次请求只有 50 个子请求，留足余量
  const failures = (Array.isArray(body.failures) ? body.failures : [])
    .filter(isReportedFailure)
    .slice(0, 20)
    .map((f) => ({ name: f.name, source: f.source, error: clipText(f.error) }))
  const overall = typeof body.error === 'string' && body.error.trim() ? clipText(body.error) : null

  for (const f of failures) await setPluginBuildError(db, f.name, f.source, f.error)

  const summary =
    failures.length > 0
      ? `插件构建失败：${failures.map((f) => `${f.name}（${firstLine(f.error)}）`).join('；')}`
      : overall
        ? `${phase === 'deploy' ? '部署失败' : '构建失败'}：${firstLine(overall)}`
        : null
  if (buildUuid && summary) await attachBuildError(db, buildUuid, clipText(summary))
  return json({ ok: true, recorded: failures.length })
}

/** 声明清单：root 的 manifest.json 优先，dist/manifest.json 兜底（旧仓库布局） */
async function fetchDeclaredManifest(git: GitSource, fetchImpl: typeof fetch): Promise<Manifest | string> {
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
  // 匿名读 raw.githubusercontent.com：私有仓库在这里也是 404，别让人以为只是没提交清单
  return (
    '拉不到插件的声明清单（manifest.json）：仓库不存在、是私有仓库（只支持公开的 GitHub 仓库），' +
    '或这个 commit 下没有 manifest.json——插件作者需要运行 qqbot-plugin build，并把生成的 manifest.json 提交到仓库根目录'
  )
}

// ---------- 已知插件的清单：安装校验、卸载提示、面板列表共用 ----------

/** 每个已知插件的清单：线上这份部署里的，再用 D1 存的声明清单覆盖（D1 是期望状态） */
export function knownManifests(records: readonly ManifestPluginRecord[], registry: PluginRegistry): Map<string, Manifest> {
  const map = new Map<string, Manifest>()
  for (const p of registry.all()) map.set(p.manifest.name, p.manifest)
  for (const r of records) if (r.manifest) map.set(r.name, r.manifest)
  return map
}

/**
 * 卸载 name 之后会断掉哪些插件：它们 depends 的服务只有 name 提供。
 * depends 的键是服务名（ctx.service 按服务名解析），不是插件名。
 */
export function dependentsOf(name: string, manifests: ReadonlyMap<string, Manifest>): string[] {
  const provided = manifests.get(name)?.services ?? []
  if (provided.length === 0) return []
  const elsewhere = new Set<string>()
  for (const [other, m] of manifests) if (other !== name) for (const s of m.services ?? []) elsewhere.add(s)
  const exclusive = new Set(provided.filter((s) => !elsewhere.has(s)))
  if (exclusive.size === 0) return []
  return [...manifests]
    .filter(([other, m]) => other !== name && Object.keys(m.depends ?? {}).some((d) => exclusive.has(d)))
    .map(([other]) => other)
    .sort()
}

/** 这个插件此前已经有过的 DO 类：线上部署里的，加上 D1 里存的（装的时候确认过 migrations） */
function knownDurableObjects(name: string, records: readonly ManifestPluginRecord[], registry: PluginRegistry): Set<string> {
  const known = new Set<string>(registry.get(name)?.manifest.durableObjects ?? [])
  for (const c of records.find((r) => r.name === name)?.manifest?.durableObjects ?? []) known.add(c)
  return known
}

/** 同一插件上一版的清单：D1 里存的优先，其次线上的 */
function previousManifest(name: string, records: readonly ManifestPluginRecord[], registry: PluginRegistry): Manifest | null {
  return records.find((r) => r.name === name)?.manifest ?? registry.get(name)?.manifest ?? null
}

function commandKeys(m: Manifest): Set<string> {
  const keys = new Set<string>()
  for (const c of m.commands ?? []) for (const n of [c.name, ...(c.aliases ?? [])]) keys.add(commandKey(n))
  return keys
}

function repoLabel(git: GitSource): string {
  return `${git.owner}/${git.repo}${git.subdir ? `#${git.subdir}` : ''}`
}

/**
 * 线上这份部署里「来自 D1 清单」的插件集哈希，和 manifestHash(D1 清单) 同一个算法——
 * 两者相等，就说明 D1 里的期望状态已经全部上线。老部署没有出处信息，回答不了，返回 null。
 */
async function liveManifestHash(registry: PluginRegistry): Promise<string | null> {
  const all = registry.all()
  if (all.some((p) => !p.origin)) return null
  return manifestHash(
    all
      .filter((p) => p.origin!.from === 'd1')
      .map((p) => ({ name: p.manifest.name, version: p.manifest.version, source: p.origin!.source })),
  )
}

/** 安装、升级、卸载之后的构建结果：触发了、触发失败、或者不需要 */
type BuildResponse = { buildUuid: string } | { error: string } | { skipped: true; reason: string }

/**
 * 改完清单之后要不要构建。
 *
 * D1 的期望状态已经和线上这份部署一模一样——撤掉的是还没上线的改动，比如卸载一个从没装上的插件——
 * 就不必白跑一次，构建出来还是现在这份；账本里的 pending 记录直接算完成。线上没有出处信息（老部署）
 * 判断不了，照旧触发；还有构建在跑时也照旧触发：在跑的那次可能拉的是改动之前的清单。
 */
async function buildAfterChange(scope: RequestScope, deps: AdminDeps): Promise<BuildResponse> {
  const db = scope.env.DB
  if (db) {
    const live = await liveManifestHash(deps.registry)
    if (live !== null && live === (await manifestHash(await listManifestPlugins(db)))) {
      const building = (await listInstalls(db, 50)).some((r) => r.status === 'building')
      if (!building) {
        await settlePendingInstalls(db)
        return { skipped: true, reason: '插件清单已与线上部署一致，不需要构建' }
      }
    }
  }
  const build = await triggerProjectionBuild(scope, deps)
  return build.ok ? { buildUuid: build.buildUuid } : { error: build.error }
}

const BUILD_DEFERRED: BuildResponse = { skipped: true, reason: '按请求暂不构建：改完之后调一次 POST /admin/builds' }

// ---------- 安装 / 升级 ----------

/**
 * POST /admin/manifest/plugins  { source: "git:owner/repo@sha[#subdir]" }
 *
 * 可选参数，不传就是原来的行为：
 * - `dryRun: true`：只预检，不写 D1、不记账本、不构建；返回清单摘要、警告与 DO 提示，面板据此让人确认
 * - `build: false`：只写 D1 不触发构建。批量更新时逐个写进去，最后调一次 `POST /admin/builds`
 * - `acknowledgeDurableObjects: true`：已按提示往仓库补好 migrations
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

  const out = await installFromSource(source, scope, deps, {
    acknowledgeDurableObjects: body?.acknowledgeDurableObjects === true,
  })
  if (!out.ok) return error(out.error, out.status, out.code)

  // 就地触发构建：只改 D1 清单的话，插件根本不在正在运行的 bundle 里——装了等于没装。
  // 卸载与一键更新一直是这么做的，安装以前漏了，靠面板前端补发一次；
  // 于是 curl / 脚本装完什么都不会发生，账本留一条 pending 挂到 24h 后被收敛成失败。
  // 触发失败不回滚安装（清单已经改了，回滚只会更乱），如实报出来让用户重试构建。
  const build = body?.build === false ? BUILD_DEFERRED : await buildAfterChange(scope, deps)
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

type Failure = { ok: false; error: string; status: number; code?: string }

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

/** 声明了 DO 类、但还没确认仓库 migrations 已就位——面板据此给出「我已加好」的确认入口 */
export const DO_MIGRATION_REQUIRED = 'durable_objects_migration_required'

/**
 * 声明了 Durable Object 的插件，装进来之前必须先往仓库的 wrangler.jsonc 补一条 migrations。
 *
 * 为什么非拦不可：migrations 是只追加的历史，平台靠「上次应用过的 tag」算增量，构建机没有
 * 这个持久状态、造不出正确的历史，所以 projector 选择了校验而不是合成（见 checkDoMigrations）。
 * 校验发生在 prepare 阶段——也就是说插件已经写进 D1 之后才炸，而且是**每一次**构建都炸，
 * 包括之后装别的插件、一键更新、卸载以外的任何操作，直到有人想到把它卸载。
 *
 * 只拦**新增**的类：这个插件以前有过的类（线上部署里的，或者 D1 里存的、装的时候确认过的），
 * migrations 早就在仓库里了——升级时再拦一次，会让声明了 DO 的插件永远没法一键更新。
 *
 * 运行时读不到仓库里的 wrangler.jsonc（它不在 bundle 里），没法判断那条 migrations 是否
 * 已经加好，所以只能拦下来把要加的内容原样给出，由用户确认后带 acknowledgeDurableObjects 重装。
 */
function durableObjectsNotice(declared: Manifest, known: ReadonlySet<string>): string | null {
  const added = (declared.durableObjects ?? []).filter((c) => !known.has(c))
  if (added.length === 0) return null
  const exportNames = added.map((c) => doExportName(declared.name, c))
  const tag = suggestMigrationTag(new Set<string>(), exportNames)
  return (
    `${declared.name} ${known.size > 0 ? '的新版本新增了' : '声明了'} Durable Object 类（${added.join('、')}），装进来之前需要先改仓库。\n` +
    'DO 的 migrations 是只追加的历史，平台靠「上次应用过的 tag」算增量，构建机没有这个状态、造不出来。\n' +
    '请在 apps/seed/wrangler.jsonc 的 migrations 末尾追加一项并提交（tag 不能与已有重复）：\n' +
    `  { "tag": "${tag}", "new_sqlite_classes": [${exportNames.map((n) => `"${n}"`).join(', ')}] }\n` +
    '不加就装的话，之后每一次构建都会失败（包括装别的插件），直到把它卸载。\n' +
    '已经加好并推送了？确认后重新安装即可。'
  )
}

/** 拉到并校验过的声明清单，以及判断它能不能装要用到的上下文 */
interface Inspected {
  ok: true
  git: GitSource
  declared: Manifest
  entry: ManifestPluginEntry
  records: ManifestPluginRecord[]
  /** D1 里的同名条目（有即为升级） */
  existing: ManifestPluginRecord | undefined
  known: Map<string, Manifest>
  /** 新增了 DO 类时要给用户看的 migrations 提示；null 表示不需要确认 */
  doNotice: string | null
}

/** 拉声明清单并做格式校验 */
async function inspectSource(source: string, scope: RequestScope, deps: AdminDeps): Promise<Inspected | Failure> {
  const db = await requireDb(scope)
  if (!db) return { ok: false, error: '未绑定 D1，无法安装插件', status: 503 }

  const git = parseGitSource(source)
  if (!git) return { ok: false, error: `source 需为 git:<owner>/<repo>@<commit>[#<子目录>] 格式：${source}`, status: 400 }

  const declared = await fetchDeclaredManifest(git, deps.options.fetchImpl)
  if (typeof declared === 'string') return { ok: false, error: declared, status: 400 }
  const problems = validateManifest(declared)
  if (problems.length > 0) return { ok: false, error: `声明清单非法：${problems.join('；')}`, status: 400 }

  const records = await listManifestPluginRecords(db)
  return {
    ok: true,
    git,
    declared,
    entry: { name: declared.name, version: declared.version, source },
    records,
    existing: records.find((p) => p.name === declared.name),
    known: knownManifests(records, deps.registry),
    doNotice: durableObjectsNotice(declared, knownDurableObjects(declared.name, records, deps.registry)),
  }
}

/** 装不了的情况（与以前一样的几条硬规则）：conflicts、表前缀撞车、依赖缺失 */
function blockingProblem(inspected: Inspected, deps: AdminDeps): Failure | null {
  const { declared, records, known } = inspected
  const allNames = new Set<string>([...records.map((p) => p.name), ...deps.registry.all().map((p) => p.manifest.name)])

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

  // depends 的键是服务名（ctx.service 按服务名解析）。提供者既算线上这份部署里的，也算 D1 里已经装了、
  // 还在等构建的——否则先装提供者、紧接着装使用者会被误拒。键与某个插件同名也放行（以前就这么认）。
  const services = new Set<string>()
  for (const [name, m] of known) if (name !== declared.name) for (const s of m.services ?? []) services.add(s)
  const missingDeps = Object.keys(declared.depends ?? {}).filter(
    (d) => !allNames.has(d) && !deps.registry.providerOf(d) && !services.has(d),
  )
  if (missingDeps.length > 0) {
    return { ok: false, error: `依赖未满足：${missingDeps.join('、')}（需先安装提供者，或由内置插件提供该服务）`, status: 400 }
  }
  return null
}

/**
 * 要提醒、但不拦的事。以前这些情况都能直接装上，现在也照样能装——
 * 只是写进响应的 warnings，面板在预检时摆出来让人确认。
 */
function installWarnings(inspected: Inspected, registry: PluginRegistry): string[] {
  const { declared, git, existing, known, records } = inspected
  const name = declared.name
  const warnings: string[] = []

  // 同名即覆盖：换了仓库就不是「升级」，是换成了另一家的代码
  const existingGit = existing ? parseGitSource(existing.source) : null
  const live = registry.get(name)
  if (existingGit) {
    if (!sameGitRepo(existingGit, git)) {
      warnings.push(`已装的 ${name} 来自 ${repoLabel(existingGit)}，这次会换成 ${repoLabel(git)} 的代码（同名即覆盖）`)
    }
  } else if (live && live.origin?.from !== 'd1') {
    warnings.push(`与仓库内置插件 ${name} 同名：装上后会替换内置的那一份，卸载之后内置的才会回来`)
  } else if (live?.origin) {
    // 卸载还没生效（线上还在、D1 里已经没了）又装回来
    const liveGit = parseGitSource(live.origin.source)
    if (liveGit && !sameGitRepo(liveGit, git)) {
      warnings.push(`线上的 ${name} 来自 ${repoLabel(liveGit)}，这次会换成 ${repoLabel(git)} 的代码（同名即覆盖）`)
    }
  }

  // permissions 只是知情同意，但升级新增的那几项得让人看见
  const previous = previousManifest(name, records, registry)
  if (previous) {
    const added = (declared.permissions ?? []).filter((p) => !(previous.permissions ?? []).includes(p))
    if (added.length > 0) warnings.push(`新版本新增权限：${added.join('、')}`)
  }

  // 命令撞名：运行时按优先级只有一个会响应，另一个被静默遮住
  const mine = commandKeys(declared)
  for (const [other, m] of known) {
    if (other === name) continue
    const clash = [...commandKeys(m)].filter((c) => mine.has(c))
    if (clash.length > 0) {
      warnings.push(`与 ${other} 的命令重名：${clash.map((c) => `/${c}`).join('、')}（运行时按优先级只有一个会响应）`)
    }
  }

  // conflicts 的另一个方向：新插件自己没声明，但已装的插件声明了与它冲突
  for (const [other, m] of known) {
    if (other !== name && (m.conflicts ?? []).includes(name)) warnings.push(`已装的 ${other} 声明与 ${name} 冲突`)
  }
  return warnings
}

/** 插件的第三方依赖（package.json 的 dependencies），预检时给人看 */
interface DependencyInfo {
  /** 包名 → 版本范围；框架自己的包（@qqbot/*）不在里面 */
  packages: Record<string, string>
  /** 有第三方依赖时，仓库里有没有 lockfile；没有依赖就不查，为 null */
  lockfile: boolean | null
  /** 写进了 dependencies 的框架包 */
  framework: string[]
}

/**
 * 读插件的 package.json 看依赖，有依赖再探一下 lockfile 在不在。拉不到就当没有依赖——
 * 这里只是提前提醒，真正按 lockfile 装、装不上就失败的，是构建机（见 seed 的 plugin-build.mjs）。
 */
async function inspectDependencies(git: GitSource, fetchImpl: typeof fetch): Promise<DependencyInfo> {
  const info: DependencyInfo = { packages: {}, lockfile: null, framework: [] }
  let deps: unknown
  try {
    const res = await fetchImpl(rawPluginFileUrl(git, 'package.json'), { redirect: 'follow' })
    if (!res.ok) return info
    deps = (JSON.parse(await res.text()) as { dependencies?: unknown }).dependencies
  } catch {
    return info
  }
  if (typeof deps !== 'object' || deps === null) return info
  for (const [name, range] of Object.entries(deps as Record<string, unknown>)) {
    if (typeof range !== 'string') continue
    if (name.startsWith('@qqbot/')) info.framework.push(name)
    else info.packages[name] = range
  }
  if (Object.keys(info.packages).length === 0) return info

  // 只探在不在：lockfile 动辄几百 KB，Worker 里没必要整份拉下来
  info.lockfile = false
  for (const file of ['package-lock.json', 'pnpm-lock.yaml', 'npm-shrinkwrap.json']) {
    try {
      const res = await fetchImpl(rawPluginFileUrl(git, file), { headers: { range: 'bytes=0-0' }, redirect: 'follow' })
      await res.body?.cancel()
      if (res.ok) {
        info.lockfile = true
        break
      }
    } catch {
      // 探不到当作没有
    }
  }
  return info
}

/** 依赖上注定会让构建失败的两种情况：与构建机的 planDependencyInstall 同一套规则 */
function dependencyWarnings(info: DependencyInfo): string[] {
  const names = Object.keys(info.packages)
  if (names.length === 0) return []
  const warnings: string[] = []
  if (info.lockfile === false) {
    warnings.push(`插件依赖第三方包（${names.join('、')}），但仓库里没有 lockfile：构建会失败——请插件作者提交 package-lock.json 或 pnpm-lock.yaml`)
  }
  if (info.framework.length > 0) {
    warnings.push(`dependencies 里的 ${info.framework.join('、')} 要移到 devDependencies，否则构建会失败（框架包一律用机器人仓库那一份）`)
  }
  return warnings
}

/** 预检给面板看的清单摘要 */
function summarizeManifest(m: Manifest) {
  return {
    name: m.name,
    version: m.version,
    ...(m.displayName !== undefined ? { displayName: m.displayName } : {}),
    ...(m.description !== undefined ? { description: m.description } : {}),
    permissions: m.permissions ?? [],
    services: m.services ?? [],
    depends: Object.keys(m.depends ?? {}),
    durableObjects: m.durableObjects ?? [],
    commands: (m.commands ?? []).map((c) => c.name),
  }
}

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
      // 预检不 409：把要补的 migrations 摆出来，让人确认后带 acknowledgeDurableObjects 正式装
      durableObjects: doNotice ? { required: true, message: doNotice } : null,
    },
  }
}

/** 安装/升级一个 git 来源的插件：拉声明清单校验、冲突与依赖检查、写入 D1 并记一条 pending 账本 */
async function installFromSource(
  source: string,
  scope: RequestScope,
  deps: AdminDeps,
  opts: { acknowledgeDurableObjects?: boolean } = {},
): Promise<InstallOutcome> {
  const inspected = await inspectSource(source, scope, deps)
  if (!inspected.ok) return inspected
  // 与以前同一个顺序：DO 提示先于其他校验
  if (inspected.doNotice && opts.acknowledgeDurableObjects !== true) {
    return { ok: false, status: 409, code: DO_MIGRATION_REQUIRED, error: inspected.doNotice }
  }
  const blocked = blockingProblem(inspected, deps)
  if (blocked) return blocked

  const db = scope.env.DB!
  const { entry, existing, declared } = inspected
  const warnings = installWarnings(inspected, deps.registry)
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
  // 批量更新前让人看见的两件事：新增的权限，以及新增的 DO 类（要先改仓库，不能直接勾上就更新）
  let newPermissions: string[] = []
  let newDurableObjects: string[] = []
  if (!upToDate) {
    const declared = await fetchDeclaredManifest({ ...git, sha: latestSha }, deps.options.fetchImpl)
    if (typeof declared !== 'string') {
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

  const latestSource = `git:${git.owner}/${git.repo}@${latestSha}${git.subdir ? `#${git.subdir}` : ''}`
  const outcome = await installFromSource(latestSource, scope, deps)
  if (!outcome.ok) return error(outcome.error, outcome.status, outcome.code)

  // 就地触发构建：换钉子之后不构建，新版永远不会上线
  const build = await buildAfterChange(scope, deps)
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

// ---------- 卸载 ----------

/**
 * DELETE /admin/manifest/plugins/:name[?purge=true][&build=false]
 *
 * 数据默认**保留**：卸载多半是不想要了，但误删不可逆，而留下的数据在
 * `GET /admin/storage` 里会被标成孤儿，随时可以清——比默认删安全，又不至于管不了。
 *
 * D1 里有、但从没真正装上（构建失败）的插件同样走这里：它不在部署里，没有 onUninstall 可跑；
 * 删掉之后 D1 就和线上一致了，不会白触发一次构建。
 */
export async function uninstallManifestPlugin(
  name: string,
  purgeData: boolean,
  scope: RequestScope,
  deps: AdminDeps,
  opts: { build?: boolean } = {},
): Promise<Response> {
  const db = await requireDb(scope)
  if (!db) return error('未绑定 D1，无法卸载插件', 503)

  const existing = await getManifestPlugin(db, name)
  if (!existing) {
    const bundled = deps.registry.get(name)
    return error(bundled ? '该插件由仓库清单内置：请从 qqbot.manifest.json 移除后重新构建' : `未安装：${name}`, 404)
  }

  const records = await listManifestPluginRecords(db)
  const dependents = dependentsOf(name, knownManifests(records, deps.registry))

  // 趁插件代码还在这次部署里，先让它自己收尾；重建之后就没机会了
  const registered = deps.registry.get(name)
  const { hook, hookError } = registered
    ? await runUninstallHook(registered, scope.contexts, purgeData, deps.logger)
    : { hook: 'none' as const, hookError: undefined }

  // 把其他已知插件名一并交给清理逻辑：D1 表前缀可能碰撞（`my-plugin` vs `my_plugin`），
  // 没有这份名单就无法判断某张表到底属于谁，宁可留孤儿也不能误删邻居
  const otherNames = [...new Set([...deps.registry.all().map((p) => p.manifest.name), ...records.map((p) => p.name)])]
  const purged = purgeData ? await purgePluginData(name, scope.env, otherNames) : null
  await clearInstallMarker(name, scope.env)

  await deleteManifestPlugin(db, name)
  // 后半段：重建完成前旧代码还在跑，冷启动的 isolate 读不到标记会重跑 onInstall，把表建回来、
  // 把标记写回去（以后重装 onInstall 就静默不跑了）。等插件真的不在部署里了，由定时任务再收一次尾
  await addPendingCleanup(db, name, purgeData)
  const hash = await manifestHash(await listManifestPlugins(db))
  const install = await insertInstall(db, { action: 'uninstall', name, source: existing.source, manifestHash: hash, status: 'pending' })

  // 就地触发构建：只改 D1 清单的话，插件还留在正在运行的 bundle 里——卸载等于没生效。
  // 触发失败不回滚卸载（清单已经改了，回滚只会更乱），如实报出来让用户手动重试。
  const build = opts.build === false ? BUILD_DEFERRED : await buildAfterChange(scope, deps)

  return json({
    ok: true,
    removed: existing,
    hash,
    install,
    build,
    data: { purged: purgeData, hook, ...(hookError ? { hookError } : {}), ...(purged ?? {}) },
    ...(dependents.length > 0
      ? { warnings: [`这些插件依赖它提供的服务，卸载后调用会报错：${dependents.join('、')}`] }
      : {}),
  })
}

// ---------- 面板装的插件与线上的对照 ----------

type ManagedState = 'deployed' | 'differs' | 'not_deployed'

function lastRecordOf(name: string, recent: readonly InstallRecord[]) {
  // recent 按时间倒序，第一条就是最近的
  const r = recent.find((row) => row.name === name)
  return r ? { action: r.action, status: r.status, error: r.error, ts: r.ts, buildUuid: r.buildUuid } : null
}

/**
 * GET /admin/manifest/plugins —— D1 清单里的每个插件，和线上这份部署的对照。
 *
 * - `deployed`：线上就是这一份
 * - `differs`：线上是另一份（升级还没生效或构建失败；或者线上是被它覆盖的同名内置插件）
 * - `not_deployed`：线上根本没有——还在等构建，或者构建失败了。这类插件不在 /admin/status 的列表里
 *   （那里列的是部署里的插件），以前在面板上看不见、也卸载不了，只能 curl
 *
 * `removing` 是反过来的：线上还在跑、D1 里已经删了（卸载还没生效）。老部署没有出处信息，这一项为空，
 * `live.source` 为 null，`deployed / differs` 只能按版本号猜。
 */
export async function listManagedPlugins(scope: RequestScope, deps: AdminDeps): Promise<Response> {
  const db = await requireDb(scope)
  if (!db) return error('未绑定 D1，没有面板装的插件', 503)

  const records = await listManifestPluginRecords(db)
  const recent = await listInstalls(db, 100)
  const hash = await manifestHash(records.map(({ name, version, source }) => ({ name, version, source })))
  const liveHash = await liveManifestHash(deps.registry)

  const plugins = records.map((r) => {
    const live = deps.registry.get(r.name)
    let state: ManagedState = 'not_deployed'
    if (live) {
      const same = live.origin ? live.origin.from === 'd1' && live.origin.source === r.source : live.manifest.version === r.version
      state = same ? 'deployed' : 'differs'
    }
    return {
      name: r.name,
      version: r.version,
      source: r.source,
      addedAt: r.addedAt,
      updatedAt: r.updatedAt,
      state,
      live: live ? { version: live.manifest.version, source: live.origin?.source ?? null, from: live.origin?.from ?? null } : null,
      buildError: r.buildError,
      lastRecord: lastRecordOf(r.name, recent),
      manifest: r.manifest ? summarizeManifest(r.manifest) : null,
    }
  })

  const inD1 = new Set(records.map((r) => r.name))
  const removing = deps.registry
    .all()
    .filter((p) => p.origin?.from === 'd1' && !inD1.has(p.manifest.name))
    .map((p) => ({ name: p.manifest.name, version: p.manifest.version, source: p.origin!.source, lastRecord: lastRecordOf(p.manifest.name, recent) }))

  return json({
    ok: true,
    hash,
    liveHash,
    // null：老部署，判断不了
    inSync: liveHash === null ? null : liveHash === hash,
    building: recent.some((r) => r.status === 'building'),
    plugins,
    removing,
  })
}

// ---------- 构建触发与账本 ----------

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
  // 只用默认域名：它直连 Cloudflare 边缘、不依赖用户的 DNS。
  // 拿不到自己的对外地址就别乱写——写进去一个错的 MANIFEST_URL 比不写更难查
  const domain = scope.env.CF_DEFAULT_DOMAIN
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
    let succeeded = false
    for (const row of rows) {
      if (!row.buildUuid || (row.status !== 'building' && row.status !== 'pending')) continue
      const build = byUuid.get(row.buildUuid)
      if (!build) continue
      const { status: next, cfStatus } = buildToInstallState(build)
      const commitHash = build.build_trigger_metadata?.commit_hash ?? null
      if (next === 'ok') succeeded = true
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
        if (next === 'failed') row.error = row.error ?? `构建未成功：${cfStatus}`
      }
    }
    // 有构建成功了：它拉的是当时的完整清单，里面每个插件都编过了，之前记下的构建错误都过时了
    if (succeeded) await clearPluginBuildErrors(db).catch(() => {})
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
        row.error = row.error ?? message
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
      row.error = row.buildUuid ? (row.error ?? message) : message
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

/** 连同配置、优先级、启用状态一起从快照里拿掉（卸载时选了清数据才走到这里） */
async function dropPluginState(env: RuntimeEnv, name: string): Promise<void> {
  const snapshot = await readSnapshot(env, true)
  if (!(name in snapshot.plugins)) return
  const plugins = { ...snapshot.plugins }
  delete plugins[name]
  await writeSnapshot(env, { ...snapshot, plugins })
}

/**
 * 卸载的后半段，由 Cron 调用：等插件真的不在这份部署里了，再删一遍 onInstall 标记，按需再清一遍数据。
 *
 * 卸载请求当场已经清过一次，但重建完成前旧代码还在跑——冷启动的 isolate 读不到标记会重跑 onInstall，
 * 把表建回来、把标记写回去，以后重装时 onInstall 就静默不跑了。在旧代码没机会再动之后收尾，
 * 这两件事才靠得住。插件还在部署里（重建没完成、构建失败）就等下一次；清数据还会连快照里的配置一起清。
 */
export async function processPendingCleanups(scope: RequestScope, deps: AdminDeps): Promise<void> {
  const db = scope.env.DB
  if (!db) return
  try {
    const pending = await listPendingCleanups(db)
    const ready = pending.filter((c) => !deps.registry.get(c.name))
    if (ready.length === 0) return

    // 与 purgeOrphan 同一份「已知插件名」：表前缀可能撞车，名单越全越不会误删邻居
    const known = new Set<string>(deps.registry.all().map((p) => p.manifest.name))
    for (const p of await listManifestPlugins(db)) known.add(p.name)
    for (const r of await listInstalls(db, 200)) if (r.name) known.add(r.name)

    for (const c of ready) {
      await clearInstallMarker(c.name, scope.env)
      if (c.purge) {
        await purgePluginData(c.name, scope.env, [...known])
        await dropPluginState(scope.env, c.name)
      }
      await removePendingCleanup(db, c.name)
      deps.logger.info('卸载收尾完成', { plugin: c.name, purge: c.purge })
    }
  } catch (err) {
    deps.logger.warn('卸载收尾失败，下次定时任务再试', { error: err instanceof Error ? err.message : String(err) })
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
