import { OpCode, signCallback, verifyEvent, type CallbackVerifyData, type WebhookPayload } from '@qqbot/api'
import type { Logger } from '@qqbot/sdk'
import { claimEvent } from './dedupe.js'
import { recordEvent } from './events.js'
import { error, json } from './http.js'
import { errorInfo } from './logger.js'
import { DISPATCH_KIND } from './logs.js'
import type { RequestScope } from './scope.js'
import type { ResolvedOptions } from './types.js'

const ACK = { op: OpCode.HttpCallbackAck }

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

  // 回调验证只做软校验：签名不符仅告警，保证平台侧的地址配置总能完成
  if (payload.op === OpCode.CallbackVerify) {
    const d = (payload.d ?? {}) as Partial<CallbackVerifyData>
    if (!d.plain_token || !d.event_ts) return error('缺少 plain_token / event_ts', 400)
    if (!signatureValid) logger.warn('回调验证请求的签名不符，仍返回签名')
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

    scope.execCtx.waitUntil(
      scope.dispatchPayload(payload).then(
        async ({ session, report, outbox, failed }) => {
          // 面板的「最近事件」和 24 小时统计按 kind 从 Workers Logs 查（logs.ts），改字段要两边一起改。
          // 不带正文：正文只在面板开着实时调试时写进 D1
          logger.info('事件已分发', {
            kind: DISPATCH_KIND,
            id,
            event: session.event,
            scene: session.scene,
            userId: session.userId,
            targetId: session.targetId,
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
      ),
    )
    return json(ACK)
  }

  logger.info('收到未处理的 op', { op: payload.op })
  return json(ACK)
}
