/**
 * 构建机调用的三个端点：拉清单（/admin/build-manifest）、拉绑定配置（/admin/build-config）、
 * 回报失败原因（/admin/build-report）。三者共用 authorizeBuildMachine 鉴权。
 */
import { requireDb } from './adminDb.js'
import { authenticate, bearerOf, constantTimeEqual } from './auth.js'
import { inFlight } from './buildLedger.js'
import { error, json, readJson } from './http.js'
import { attachBuildError, listInstalls, listManifestPlugins, manifestHash, setPluginBuildError } from './manifestStore.js'
import type { RequestScope } from './scope.js'

/**
 * 构建机的鉴权：配置了 BUILD_TOKEN 用它，否则与管理 API 同一鉴权（ADMIN_TOKEN/会话令牌）。
 * 两者都只认请求头（构建脚本一直用 `Authorization: Bearer`），且恒定时间比较。
 */
async function authorizeBuildMachine(request: Request, scope: RequestScope): Promise<boolean> {
  const buildToken = scope.env.BUILD_TOKEN
  const bearer = bearerOf(request)
  if (buildToken && bearer && (await constantTimeEqual(bearer, buildToken))) return true
  // 这里照旧认 `?token=`（管理 API 那边关掉了）：构建脚本会原样保留 MANIFEST_URL 里的查询串，
  // 手工把管理密钥写进 MANIFEST_URL 的老配置关掉就会 401、构建直接失败
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
    : recent.find(inFlight)
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
 * body: { buildUuid?, phase: 'prepare' | 'deploy' | 'health', failures?: [{ name, source, error }], error? }
 * `health` 是部署前的健康检查（`/healthz?plugins=1`）发现插件在新版本里加载不了：编译过了，但一加载就抛错，
 * 同样不切流量。老 Worker 不认这个值，按 prepare 记，只是文案笼统一些。
 */
export async function handleBuildReport(request: Request, scope: RequestScope): Promise<Response> {
  if (!(await authorizeBuildMachine(request, scope))) return error('未授权', 401)
  const db = await requireDb(scope)
  if (!db) return error('未绑定 D1，无处记录构建结果', 503)

  const body = await readJson<{ buildUuid?: unknown; phase?: unknown; failures?: unknown; error?: unknown }>(request)
  if (!body) return error('请求体格式错误', 400)
  const buildUuid = typeof body.buildUuid === 'string' && body.buildUuid.trim() ? body.buildUuid.trim() : null
  const phase = body.phase === 'deploy' || body.phase === 'health' ? body.phase : 'prepare'
  // 每条失败一次 D1 写入：免费版一次请求只有 50 个子请求，留足余量
  const failures = (Array.isArray(body.failures) ? body.failures : [])
    .filter(isReportedFailure)
    .slice(0, 20)
    .map((f) => ({ name: f.name, source: f.source, error: clipText(f.error) }))
  const overall = typeof body.error === 'string' && body.error.trim() ? clipText(body.error) : null

  for (const f of failures) await setPluginBuildError(db, f.name, f.source, f.error)

  const summary =
    failures.length > 0
      ? `${phase === 'health' ? '插件加载失败，未切流量' : '插件构建失败'}：${failures.map((f) => `${f.name}（${firstLine(f.error)}）`).join('；')}`
      : overall
        ? `${phase === 'deploy' ? '部署失败' : phase === 'health' ? '健康检查失败' : '构建失败'}：${firstLine(overall)}`
        : null
  if (buildUuid && summary) await attachBuildError(db, buildUuid, clipText(summary))
  return json({ ok: true, recorded: failures.length })
}
