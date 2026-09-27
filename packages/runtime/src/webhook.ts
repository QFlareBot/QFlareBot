import { OpCode, signCallback, verifyEvent, type CallbackVerifyData, type WebhookPayload } from '@qqbot/api'
import { toEventName, type Logger } from '@qqbot/sdk'
import { claimEvent } from './dedupe.js'
import type { DispatchReport } from './dispatcher.js'
import { CONTENT_LIMIT, recordEvent } from './events.js'
import { error, json } from './http.js'
import { errorInfo } from './logger.js'
import { DISPATCH_KIND } from './logs.js'
import type { RequestScope } from './scope.js'
import type { ResolvedOptions } from './types.js'

const ACK = { op: OpCode.HttpCallbackAck }

/**
 * 签名不符时，回调验证只替这种形状的 event_ts / plain_token 签名（平台发来的是秒级时间戳和一串字母数字）。
 *
 * 回调验证签的是 `event_ts + plain_token`，事件验签用的是同一把钥匙、验的是 `时间戳 + body`。
 * 不看格式照签，攻击者把伪造的事件 JSON 塞进 plain_token，拿回来的签名就能配上一个请求体通过验签。
 * 限制之后被签的整段文字里没有 `{` 和 `"`，它的任何后缀都解析不出 JSON 对象，拼不成能分发的事件
 */
const CALLBACK_TS = /^\d{1,20}$/
const CALLBACK_TOKEN = /^[A-Za-z0-9_\-+/=.]{1,256}$/

/** 事件处理整个在 waitUntil 里，平台在回应之后最多再给 30 秒；到这个点还没跑完就先留一行，免得被掐断后毫无痕迹 */
const DISPATCH_WARN_MS = 25_000

function parsePayload(rawBody: string): WebhookPayload | null {
  try {
    const payload = JSON.parse(rawBody) as WebhookPayload
    if (typeof payload.d === 'string') {
      try {
        payload.d = JSON.parse(payload.d)
      } catch {
        // d 保持字符串
      }
    }
    return payload
  } catch {
    return null
  }
}

async function verifySignature(request: Request, rawBody: string, secret: string): Promise<boolean> {
  const sig = request.headers.get('x-signature-ed25519') ?? ''
  const ts = request.headers.get('x-signature-timestamp') ?? ''
  return verifyEvent(secret, ts, rawBody, sig)
}

function timestampFresh(request: Request, toleranceSec: number): boolean {
  const ts = Number(request.headers.get('x-signature-timestamp'))
  if (!Number.isFinite(ts)) return false
  return Math.abs(Date.now() / 1000 - ts) <= toleranceSec
}

const SCENE_TARGET: Record<string, string> = { group: '群', c2c: '单聊', guild: '频道', guild_dm: '频道私信' }
/** openid 很长，日志一行里只留开头几位，够对上号就行；完整的在 data 里 */
const short = (id: string) => (id.length > 8 ? `${id.slice(0, 8)}…` : id)

/**
 * 事件摘要日志的 message：Cloudflare 后台日志列表的 Message 列就显示它，所以写成一眼能看懂的一行。
 * 这一行永远不带消息正文（开了 logContent 正文也只放进 data）。面板按 data.kind 查，这行文字随便改不影响查询
 */
export function dispatchMessage(
  event: string,
  scene: string,
  targetId: string,
  userId: string,
  report: DispatchReport,
  outbox: number,
  failed: number,
): string {
  const where = [SCENE_TARGET[scene] && targetId ? `${SCENE_TARGET[scene]} ${short(targetId)}` : '', userId ? `用户 ${short(userId)}` : '']
  const matched = report.matched.length ? report.matched.map((m) => `${m.plugin}/${m.name}`).join('、') : '无插件命中'
  const first = report.errors[0]
  const result = first
    ? `${report.errors.length} 个错误：${first.plugin} ${first.message.slice(0, 80)}`
    : failed
      ? `发送失败 ${failed} 条`
      : outbox
        ? `回复 ${outbox} 条`
        : '无回复'
  return [event.replace(/^qq\./, ''), ...where.filter(Boolean)].join(' · ') + ` → ${matched} · ${result}`
}

/** QQ 回调入口：op 13 回签名，op 0 验签后立即 ACK 并在后台分发 */
export async function handleWebhook(
  request: Request,
  scope: RequestScope,
  options: ResolvedOptions,
  logger: Logger,
): Promise<Response> {
  if (request.method !== 'POST') return error('Method Not Allowed', 405)
  if (!scope.bot) return error('机器人尚未配置 AppID/AppSecret', 503)

  const rawBody = await request.text()
  const payload = parsePayload(rawBody)
  if (!payload) return error('请求体不是合法 JSON', 400)

  const signatureValid = await verifySignature(request, rawBody, scope.bot.secret)

  // 回调验证只做软校验：签名不符仅告警，保证平台侧的地址配置总能完成。
  // 但签名不符时只签格式正常的 token，否则这里就成了替任意内容签名的机器（见 CALLBACK_TOKEN）
  if (payload.op === OpCode.CallbackVerify) {
    const d = (payload.d ?? {}) as Partial<CallbackVerifyData>
    if (!d.plain_token || !d.event_ts) return error('缺少 plain_token / event_ts', 400)
    if (!signatureValid) {
      if (!CALLBACK_TS.test(String(d.event_ts)) || !CALLBACK_TOKEN.test(String(d.plain_token))) {
        logger.warn('回调验证请求的签名不符，plain_token / event_ts 格式也不对，已拒绝')
        return error('签名校验失败', 401)
      }
      logger.warn('回调验证请求的签名不符，仍返回签名')
    }
    const signature = await signCallback(scope.bot.secret, d.event_ts, d.plain_token)
    logger.info('回调地址验证完成')
    return json({ plain_token: d.plain_token, signature })
  }

  if (!signatureValid) {
    logger.warn('Webhook 签名校验失败', { op: payload.op })
    return error('签名校验失败', 401)
  }

  if (payload.op === OpCode.Dispatch) {
    if (!timestampFresh(request, options.timestampToleranceSec)) {
      logger.warn('事件时间戳超出允许范围，已拒绝', { id: payload.id })
      return error('时间戳过期', 401)
    }
    const id = payload.id ?? `${payload.t}:${(payload.d as { id?: string } | undefined)?.id ?? rawBody.length}`
    if (!(await claimEvent(scope.env, id, options.dedupeTtlSec))) {
      logger.info('重复事件已忽略', { id })
      return json(ACK)
    }

    // 被平台掐断时下面 .then 里的事件摘要一行都不会写，只能靠这条告警知道是哪个事件卡住了。
    // 定时器不交给 waitUntil，分发结束就清掉，不会反过来把请求撑到 25 秒
    const slow = setTimeout(
      () => logger.warn('事件处理已超过 25 秒，30 秒时会被平台中断', { id, event: toEventName(payload.t ?? 'UNKNOWN') }),
      DISPATCH_WARN_MS,
    )
    scope.execCtx.waitUntil(
      scope.dispatchPayload(payload).then(
        async ({ session, report, outbox, failed }) => {
          // 面板的「最近事件」和 24 小时统计按 kind 从 Workers Logs 查（logs.ts），改字段要两边一起改。
          // 正文默认不进日志（设置里开了 logContent 才带）；面板开着实时调试时另写进 D1
          const summary = dispatchMessage(session.event, session.scene, session.targetId, session.userId, report, outbox, failed)
          logger.info(summary, {
            kind: DISPATCH_KIND,
            id,
            event: session.event,
            scene: session.scene,
            userId: session.userId,
            targetId: session.targetId,
            ...(scope.snapshot.logContent && session.content ? { content: session.content.slice(0, CONTENT_LIMIT) } : {}),
            matched: report.matched,
            errors: report.errors.length ? report.errors : undefined,
            outbox,
            failed,
            ok: report.errors.length === 0 && failed === 0,
          })
          await recordEvent(
            scope.env,
            {
              id,
              event: session.event,
              scene: session.scene,
              userId: session.userId,
              targetId: session.targetId,
              content: session.content,
              report,
              outbox,
              failed,
            },
            logger,
          )
        },
        (err) => logger.error('事件分发异常', { id, ...errorInfo(err) }),
      ).finally(() => clearTimeout(slow)),
    )
    return json(ACK)
  }

  logger.info('收到未处理的 op', { op: payload.op })
  return json(ACK)
}
