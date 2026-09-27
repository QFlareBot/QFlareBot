/**
 * 期望状态与线上的对照：D1 清单是期望状态，注册表里是这份部署实际在跑的插件。
 * liveManifestHash 回答「期望状态是否已经全部上线」（改完清单要不要构建也靠它），
 * GET /admin/manifest/plugins 把两边逐个对照着列出来。
 */
import { requireDb } from './adminDb.js'
import { error, json } from './http.js'
import { summarizeManifest } from './installChecks.js'
import { listInstalls, listManifestPluginRecords, manifestHash, type InstallRecord } from './manifestStore.js'
import type { PluginRegistry } from './registry.js'
import type { RequestScope } from './scope.js'
import type { AdminDeps } from './admin.js'

/**
 * 线上这份部署里「来自 D1 清单」的插件集哈希，和 manifestHash(D1 清单) 同一个算法——
 * 两者相等，就说明 D1 里的期望状态已经全部上线。老部署没有出处信息，回答不了，返回 null。
 */
export async function liveManifestHash(registry: PluginRegistry): Promise<string | null> {
  const all = registry.all()
  if (all.some((p) => !p.origin)) return null
  return manifestHash(
    all
      .filter((p) => p.origin!.from === 'd1')
      .map((p) => ({ name: p.manifest.name, version: p.manifest.version, source: p.origin!.source })),
  )
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
