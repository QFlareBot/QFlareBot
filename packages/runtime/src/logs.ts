import type { EventRecord } from './events.js'
import type { RuntimeEnv } from './types.js'

/**
 * 从 Workers Logs 读事件摘要：webhook 每个事件打一行 `kind: 'dispatch'` 的结构化日志（见 webhook.ts），
 * 面板的「最近事件」和 24 小时统计都从这里查，D1 不再为每个事件存一行。
 *
 * 用的是构建 token（CF_BUILDS_TOKEN），要多一项「Workers Observability 编辑」权限：
 * 查询接口只认这一项，只读也一样。老部署的 token 没有这项，编辑 token 补上即可（值不变）。
 *
 * 查询结果会被平台自适应抽样（statistics.abr_level、sampleInterval > 1）：账户里日志量大、
 * 时间窗口大时只扫 10% 或 1% 的数据再按比例放大。实测一两个小时的窗口基本不抽样，
 * 所以列表按窗口由近到远分段查；统计数字被抽样时如实标出来，面板显示成估算值。
 */

export const DISPATCH_KIND = 'dispatch'

/** 分段边界（毫秒，相对查询终点）；最远 7 天是付费版的保留期 */
const WINDOWS_MS = [1, 24, 168].map((h) => h * 3600_000)
const STATS_TTL_MS = 60_000
/** 查询要扫整个账户的日志：日志量大的账户实测一次 5～12 秒 */
const TIMEOUT_MS = 20_000

export type LogsUnavailableReason = 'no-token' | 'no-permission' | 'error'

export class LogsUnavailable extends Error {
  constructor(
    readonly reason: LogsUnavailableReason,
    message: string,
  ) {
    super(message)
  }
}

export interface DispatchStats {
  /** 兼容旧字段：以前是事件表的行数，现在与 last24h 相同 */
  total: number
  last24h: number
  errors24h: number
  /** 平台抽样后按比例放大的估算值 */
  sampled?: boolean
}

interface QueryFilter {
  key: string
  operation: 'eq'
  type: 'string' | 'number' | 'boolean'
  value: string | number | boolean
}

interface TelemetryEvent {
  timestamp: number
  source?: { data?: Record<string, unknown> }
}

interface TelemetryResult {
  events?: { events?: TelemetryEvent[] }
  calculations?: Array<{ aggregates?: Array<{ groups?: Array<{ value: unknown }>; count?: number; sampleInterval?: number }> }>
  statistics?: { abr_level?: number }
}

function workerName(env: RuntimeEnv): string {
  for (const v of [env.CF_WORKER_NAME, env.WORKER_NAME]) if (typeof v === 'string' && v) return v
  return 'qqbot'
}

function dispatchFilters(env: RuntimeEnv): QueryFilter[] {
  return [
    { key: '$metadata.service', operation: 'eq', type: 'string', value: workerName(env) },
    { key: 'data.kind', operation: 'eq', type: 'string', value: DISPATCH_KIND },
  ]
}

async function query(env: RuntimeEnv, fetchImpl: typeof fetch, body: Record<string, unknown>): Promise<TelemetryResult> {
  const { CF_ACCOUNT_ID, CF_BUILDS_TOKEN } = env
  if (!CF_ACCOUNT_ID || !CF_BUILDS_TOKEN) throw new LogsUnavailable('no-token', '未配置 CF_ACCOUNT_ID / CF_BUILDS_TOKEN')
  let res: Response
  try {
    res = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/observability/telemetry/query`, {
      method: 'POST',
      headers: { authorization: `Bearer ${CF_BUILDS_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ queryId: 'qflarebot-panel', ...body }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    throw new LogsUnavailable('error', `查询 Workers Logs 失败：${(err as Error).message}`)
  }
  const data = (await res.json().catch(() => null)) as {
    success?: boolean
    result?: TelemetryResult
    errors?: Array<{ code?: number; message?: string }>
  } | null
  if (res.ok && data?.success && data.result) return data.result
  // 缺权限时接口回 10000 Authentication error（HTTP 401/403）
  if (res.status === 401 || res.status === 403 || data?.errors?.some((e) => e.code === 10000)) {
    throw new LogsUnavailable('no-permission', '构建 Token 缺少「Workers Observability 编辑」权限')
  }
  const message = data?.errors?.map((e) => e.message).filter(Boolean).join('；') || `HTTP ${res.status}`
  throw new LogsUnavailable('error', `查询 Workers Logs 失败：${message}`)
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const num = (v: unknown) => (typeof v === 'number' ? v : 0)

/** 日志里的事件摘要换成面板认得的 EventRecord；日志里不带正文 */
function toRecord(e: TelemetryEvent): EventRecord | null {
  const d = e.source?.data
  if (!d || typeof d.id !== 'string') return null
  return {
    id: d.id,
    ts: e.timestamp,
    event: str(d.event),
    scene: str(d.scene),
    user_id: str(d.userId),
    target_id: str(d.targetId),
    content: '',
    matched: JSON.stringify(Array.isArray(d.matched) ? d.matched : []),
    errors: JSON.stringify(Array.isArray(d.errors) ? d.errors : []),
    outbox: num(d.outbox),
    failed: num(d.failed),
  }
}

/**
 * 最近的事件摘要，新的在前；`before` 为毫秒时间戳，翻页用。
 *
 * 由近到远分三段同时查：近的一段窗口小、基本不被抽样，远的只在近处凑不够时才用得上。
 * 一次查询要好几秒，排队查太慢，所以宁可多打两次接口。只有最后返回的记录里
 * 真有来自被抽样那一段的，才标 sampled
 */
export async function listDispatchLogs(
  env: RuntimeEnv,
  fetchImpl: typeof fetch,
  options: { limit?: number; before?: number } = {},
): Promise<{ events: EventRecord[]; sampled: boolean }> {
  const limit = Math.min(200, Math.max(1, options.limit ?? 50))
  const end = options.before ?? Date.now()
  const segments = await Promise.all(
    WINDOWS_MS.map(async (far, i) => {
      const near = WINDOWS_MS[i - 1] ?? 0
      // 相邻两段错开 1 毫秒，翻页时也不带上 before 那一条本身
      const to = near === 0 && !options.before ? end : end - near - 1
      const result = await query(env, fetchImpl, {
        timeframe: { from: end - far, to },
        view: 'events',
        limit,
        parameters: { filters: dispatchFilters(env) },
      })
      const sampled = (result.statistics?.abr_level ?? 1) > 1
      return (result.events?.events ?? []).flatMap((e) => {
        const record = toRecord(e)
        return record ? [{ record, sampled }] : []
      })
    }),
  )
  const seen = new Set<string>()
  const picked = segments
    .flat()
    .sort((a, b) => b.record.ts - a.record.ts)
    .filter(({ record }) => !seen.has(record.id) && seen.add(record.id))
    .slice(0, limit)
  return { events: picked.map((p) => p.record), sampled: picked.some((p) => p.sampled) }
}

async function fetchStats(env: RuntimeEnv, fetchImpl: typeof fetch): Promise<DispatchStats> {
  const now = Date.now()
  const result = await query(env, fetchImpl, {
    timeframe: { from: now - 24 * 3600_000, to: now },
    view: 'calculations',
    ignoreSeries: true,
    parameters: {
      calculations: [{ operator: 'count', alias: 'n' }],
      groupBys: [{ type: 'boolean', value: 'data.ok' }],
      filters: dispatchFilters(env),
    },
  })
  let last24h = 0
  let errors24h = 0
  let sampled = (result.statistics?.abr_level ?? 1) > 1
  for (const a of result.calculations?.[0]?.aggregates ?? []) {
    const count = Math.round(a.count ?? 0)
    last24h += count
    // 分组值是字符串 'true' / 'false'
    if (String(a.groups?.[0]?.value) === 'false') errors24h += count
    if ((a.sampleInterval ?? 1) > 1) sampled = true
  }
  return { total: last24h, last24h, errors24h, ...(sampled ? { sampled } : {}) }
}

let statsCache: { key: string; at: number; value: DispatchStats | null; pending?: Promise<void> | undefined } | null = null

/**
 * 24 小时事件数与出错数；查不到（没 token、缺权限、接口出错）或还没查回来时返回 null。
 *
 * 面板每 5 秒拉一次 /admin/status，而一次查询要好几秒，绝不能让 status 等它：
 * 结果（包括查不到）缓存 STATS_TTL_MS，过期或还没有时都只在后台刷新，先返回手上的值
 */
export async function dispatchStats(
  env: RuntimeEnv,
  fetchImpl: typeof fetch,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<DispatchStats | null> {
  if (!env.CF_ACCOUNT_ID || !env.CF_BUILDS_TOKEN) return null
  const key = `${env.CF_ACCOUNT_ID}:${workerName(env)}`
  if (statsCache?.key !== key) statsCache = { key, at: 0, value: null }
  const entry = statsCache
  const refresh = () =>
    (entry.pending ??= fetchStats(env, fetchImpl)
      .catch(() => null)
      .then((value) => {
        entry.value = value
        entry.at = Date.now()
        entry.pending = undefined
      }))
  if (Date.now() - entry.at > STATS_TTL_MS) waitUntil(refresh())
  return entry.value
}

/** 测试用 */
export function resetLogsCache(): void {
  statsCache = null
}
