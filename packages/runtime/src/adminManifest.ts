import { CloudflareBuildsApi } from '@qqbot/projector'
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
  return json({ ok: true, hash: await manifestHash(plugins), plugins, generatedAt: new Date().toISOString() })
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

  const body = await readJson<{ source?: string }>(request)
  const source = body?.source?.trim()
  if (!source) return error('需要 source，例如 git:owner/repo@a1b2c3d4e5', 400)
  const git = parseGitSource(source)
  if (!git) return error(`source 需为 git:<owner>/<repo>@<commit>[#<子目录>] 格式：${source}`, 400)

  const declared = await fetchDeclaredManifest(git, deps.options.fetchImpl)
  if (typeof declared === 'string') return error(declared, 400)
  const problems = validateManifest(declared)
  if (problems.length > 0) return error(`声明清单非法：${problems.join('；')}`, 400)

  const installed = await listManifestPlugins(db)
  const registryNames = new Set(deps.registry.all().map((p) => p.manifest.name))
  const allNames = new Set<string>([...installed.map((p) => p.name), ...registryNames])

  const conflict = (declared.conflicts ?? []).find((c) => allNames.has(c))
  if (conflict) return error(`安装 ${declared.name} 与已装插件冲突：${declared.name} conflicts ${conflict}`, 409)
  const missingDeps = Object.keys(declared.depends ?? {}).filter((d) => !allNames.has(d) && !deps.registry.providerOf(d))
  if (missingDeps.length > 0) {
    return error(`依赖未满足：${missingDeps.join('、')}（需先安装提供者，或由内置插件提供该服务）`, 400)
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
  return json({ ok: true, plugin: entry, ...(existing ? { previous: { version: existing.version } } : {}), hash, install })
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

  const purged = purgeData ? await purgePluginData(name, scope.env) : null
  await clearInstallMarker(name, scope.env)

  await deleteManifestPlugin(db, name)
  const hash = await manifestHash(await listManifestPlugins(db))
  const install = await insertInstall(db, { action: 'uninstall', name, source: existing.source, manifestHash: hash, status: 'pending' })
  return json({
    ok: true,
    removed: existing,
    hash,
    install,
    data: { purged: purgeData, hook, ...(hookError ? { hookError } : {}), ...(purged ?? {}) },
  })
}

function buildsApi(scope: RequestScope, deps: AdminDeps): CloudflareBuildsApi | null {
  const { CF_ACCOUNT_ID, CF_BUILDS_TOKEN } = scope.env
  if (!CF_ACCOUNT_ID || !CF_BUILDS_TOKEN) return null
  return new CloudflareBuildsApi({ accountId: CF_ACCOUNT_ID, apiToken: CF_BUILDS_TOKEN, fetchImpl: deps.options.fetchImpl })
}

function cfStatusToInstall(status: string): InstallRecord['status'] {
  const v = status.toLowerCase()
  if (v === 'success') return 'ok'
  if (v === 'failed' || v === 'canceled' || v === 'cancelled') return 'failed'
  return 'building'
}

/** POST /admin/builds —— 触发 Workers Builds 重建当前清单（body 可传 { branch }） */
export async function triggerBuild(request: Request, scope: RequestScope, deps: AdminDeps): Promise<Response> {
  const env = scope.env
  const missing = (['CF_ACCOUNT_ID', 'CF_BUILDS_TOKEN', 'CF_WORKER_TAG', 'CF_TRIGGER_UUID'] as const).filter((k) => !env[k])
  if (missing.length > 0) {
    return error(`自部署未配置，缺少环境变量：${missing.join('、')}（设置步骤见 seed README）`, 503)
  }
  const db = await requireDb(scope)
  if (!db) return error('未绑定 D1，无法记录构建', 503)

  const body = await readJson<{ branch?: string }>(request).catch(() => null)
  const branch = body?.branch?.trim() || env.CF_BUILD_BRANCH || 'main'
  const hash = await manifestHash(await listManifestPlugins(db))

  const api = buildsApi(scope, deps)
  if (!api) return error('自部署未配置：缺少 CF_ACCOUNT_ID / CF_BUILDS_TOKEN', 503)
  let buildUuid: string
  try {
    ;({ buildUuid } = await api.triggerBuild(env.CF_TRIGGER_UUID!, { branch }))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await insertInstall(db, { action: 'build', name: null, source: null, manifestHash: hash, status: 'failed', error: message })
    return error(`触发构建失败：${message}`, 502)
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
  return json({ ok: true, buildUuid, branch, hash, install })
}

/** GET /admin/builds —— 安装/构建账本；配置了 CF_* 时顺带同步进行中构建的状态与 commit */
export async function listBuildsStatus(scope: RequestScope, deps: AdminDeps): Promise<Response> {
  const db = await requireDb(scope)
  if (!db) return error('未绑定 D1，无安装记录', 503)
  const rows = await listInstalls(db, 50)

  const api = buildsApi(scope, deps)
  const { CF_WORKER_TAG } = scope.env
  let syncError: string | null = null
  if (!api || !CF_WORKER_TAG) {
    // 装过插件但没有 Builds 凭据：状态永远同步不了，如实告知
    if (rows.some((r) => r.status === 'building' || r.status === 'pending')) {
      syncError = '未配置 CF_ACCOUNT_ID / CF_BUILDS_TOKEN / CF_WORKER_TAG，无法同步构建状态'
    }
  } else if (rows.some((r) => r.buildUuid && (r.status === 'building' || r.status === 'pending'))) {
    try {
      const builds = await api.listBuilds(CF_WORKER_TAG)
      const byUuid = new Map(builds.filter((b) => b.build_uuid).map((b) => [b.build_uuid!, b]))
      for (const row of rows) {
        if (!row.buildUuid || (row.status !== 'building' && row.status !== 'pending')) continue
        const build = byUuid.get(row.buildUuid)
        if (!build?.status) continue
        const next = cfStatusToInstall(build.status)
        const commitHash = build.build_trigger_metadata?.commit_hash ?? null
        if (next !== row.status || (commitHash && commitHash !== row.commitHash)) {
          await updateInstallByBuildUuid(db, row.buildUuid, {
            status: next,
            cfStatus: build.status,
            commitHash,
            ...(next === 'failed' ? { error: `构建状态：${build.status}` } : {}),
          })
          row.status = next
          row.cfStatus = build.status
          row.commitHash = commitHash
        }
      }
    } catch (err) {
      // 同步失败必须可见，否则账本会永远停在"构建中"（例如 CF_WORKER_TAG 填成了 worker 名字）
      syncError = err instanceof Error ? err.message : String(err)
      deps.logger.warn('构建状态同步失败', { error: syncError })
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

  return json({ ok: true, builds: rows, ...(syncError ? { syncError } : {}) })
}
