/**
 * 安装/构建账本与 Cloudflare 构建状态的同步：进行中的记录按 build_uuid 对上 Builds API 的结果，
 * 找不到的、卡了 24 小时的收敛成失败。面板打开时（GET /admin/builds）和 Cron 里各同步一次。
 */
import type { BuildRecord } from '@qqbot/projector'
import { requireDb } from './adminDb.js'
import { buildsApi, resolveBuildTargets } from './buildTrigger.js'
import { error, json } from './http.js'
import {
  clearPluginBuildErrors,
  listInstalls,
  updateInstallById,
  updateInstallByBuildUuid,
  type InstallRecord,
} from './manifestStore.js'
import { Keys } from './store.js'
import type { RequestScope } from './scope.js'
import type { AdminDeps } from './admin.js'

/** Builds API 的"完成与否"在 build_outcome（success/fail/skipped/cancelled/terminated），
 * status 只有 queued/initializing/running/stopped——只看 status 会把完成的构建永远当"构建中"。
 */
function buildToInstallState(build: BuildRecord): { status: InstallRecord['status']; cfStatus: string | null } {
  const outcome = build.build_outcome
  if (outcome === 'success') return { status: 'ok', cfStatus: 'success' }
  if (outcome) return { status: 'failed', cfStatus: outcome }
  return { status: 'building', cfStatus: build.status ?? null }
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
  const hasInFlight = rows.some((r) => r.buildUuid && inFlight(r))
  if (!api) {
    // 装过插件但没有 Builds 凭据：状态永远同步不了，如实告知
    if (rows.some(inFlight)) {
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
    // 按 build_uuid 去重：这次构建并进来的安装、升级、卸载与构建本身共用一个 uuid，一条 UPDATE 就全改了。
    // 以前逐行各发一次、内存里其余行还是旧状态，于是每行都再发一次——批量装 10 个插件时每次状态变化写一百来行
    const seen = new Set<string>()
    for (const row of rows) {
      if (!row.buildUuid || !inFlight(row) || seen.has(row.buildUuid)) continue
      seen.add(row.buildUuid)
      const build = byUuid.get(row.buildUuid)
      if (!build) continue
      const { status: next, cfStatus } = buildToInstallState(build)
      const commitHash = build.build_trigger_metadata?.commit_hash ?? null
      if (next === 'ok') succeeded = true
      const changed = rows.some(
        (r) =>
          r.buildUuid === row.buildUuid &&
          inFlight(r) &&
          (next !== r.status || (cfStatus && cfStatus !== r.cfStatus) || (commitHash && commitHash !== r.commitHash)),
      )
      if (changed) {
        await patchBuildRows(db, rows, row.buildUuid, {
          status: next,
          cfStatus,
          commitHash,
          ...(next === 'failed' ? { error: `构建未成功：${cfStatus}` } : {}),
        })
      }
    }
    // 有构建成功了：它拉的是当时的完整清单，里面每个插件都编过了，之前记下的构建错误都过时了
    if (succeeded) await clearPluginBuildErrors(db).catch(() => {})
    // 构建列表里找不到的 in-flight 记录：超过 30 分钟仍不出现即收敛（同一个 uuid 只改一次，patchBuildRows 把同伴一起改成终态）
    const NOT_FOUND_MS = 30 * 60 * 1000
    for (const row of rows) {
      if (!row.buildUuid || !inFlight(row)) continue
      if (!byUuid.has(row.buildUuid) && Date.now() - row.ts > NOT_FOUND_MS) {
        const message =
          'Cloudflare 构建列表中找不到该构建：可能已超出 Builds API 的返回范围（构建太多），' +
          '也可能是配置了 CF_WORKER_TAG 但填成了 worker 名字（应填 workers/scripts 返回的 tag）'
        await patchBuildRows(db, rows, row.buildUuid, { status: 'failed', cfStatus: 'not_found', error: message })
      }
    }
  }

  await settleStaleRecords(db, rows)
  return syncError
}

export function inFlight(row: InstallRecord): boolean {
  return row.status === 'building' || row.status === 'pending'
}

/**
 * 按 build_uuid 改一次账本，并把内存里同 uuid 的行一起改掉——D1 那条 UPDATE 本来就是一起改的，
 * 内存不跟上的话，后面的同伴行会被当成「还没改」再发一次。cfStatus / commitHash 没给就保留原值，与 SQL 的 COALESCE 一致
 */
async function patchBuildRows(
  db: D1Database,
  rows: InstallRecord[],
  buildUuid: string,
  patch: { status: InstallRecord['status']; cfStatus?: string | null; commitHash?: string | null; error?: string },
): Promise<void> {
  await updateInstallByBuildUuid(db, buildUuid, patch)
  for (const r of rows) {
    if (r.buildUuid !== buildUuid) continue
    r.status = patch.status
    if (patch.cfStatus) r.cfStatus = patch.cfStatus
    if (patch.commitHash) r.commitHash = patch.commitHash
    if (patch.error) r.error = r.error ?? patch.error
  }
}

/** 卡死收敛：超过 24h 仍是非终态的记录按失败处理，避免账本永远"构建中"（实际结果未知）。纯 D1，不联网 */
async function settleStaleRecords(db: D1Database, rows: InstallRecord[]): Promise<void> {
  const STALE_MS = 24 * 60 * 60 * 1000
  const message = '构建状态超过 24h 未同步，已按失败处理（实际结果未知）'
  for (const row of rows) {
    if (!inFlight(row) || Date.now() - row.ts <= STALE_MS) continue
    if (row.buildUuid) {
      await patchBuildRows(db, rows, row.buildUuid, { status: 'failed', error: message })
    } else {
      await updateInstallById(db, row.id, { status: 'failed', error: message })
      row.status = 'failed'
      row.error = message
    }
  }
}

/** 两次自动同步之间的最短间隔：cron 每分钟都会来，构建通常跑几分钟，没必要每分钟问一次 */
const LEDGER_SYNC_INTERVAL_MS = 3 * 60 * 1000

/**
 * Cron 里的账本同步。只有账本里真有「要问 Cloudflare」的记录才会走到网络，
 * 并用 KV 时间戳节流——否则每分钟一次 cron 会把 Builds API 打成 1440 次/天。
 */
export async function syncBuildLedgerOnSchedule(scope: RequestScope, deps: AdminDeps): Promise<void> {
  const db = scope.env.DB
  if (!db) return
  try {
    const rows = await listInstalls(db, 50)
    if (!rows.some(inFlight)) return

    // 要问 Cloudflare 的只有带 build_uuid 的进行中记录，而且得配了 Builds 凭证（syncBuildLedger 同样据此决定联不联网）。
    // 只剩没有 build_uuid 的 pending 时——构建 token 没配、构建触发失败、`build: false` 之后没再构建——
    // 联网也没东西可问，只做 24 小时收敛：纯 D1，不碰 KV。以前这时照样先写节流时间戳，
    // 每 3 分钟一次、一天白写约 480 次 KV，一直写到 24 小时后记录被收敛。
    const canAsk = !!(scope.env.CF_ACCOUNT_ID && scope.env.CF_BUILDS_TOKEN)
    if (!canAsk || !rows.some((r) => r.buildUuid && inFlight(r))) {
      await settleStaleRecords(db, rows)
      return
    }

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
