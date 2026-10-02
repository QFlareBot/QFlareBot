/**
 * 已收录的平台业务错误码说明（来源：官方文档与实测，如 docs/capabilities.md）。
 * 未收录的码不猜语义，只透传平台 message；遇到新码欢迎补录这张表。
 */
const CODE_HINTS: Record<number, string> = {
  // 群成员列表、批量移除、黑名单、入群审批策略等接口平台标注"内邀接入中"，未开白名单返回此码（实测）
  11253: '该接口需要平台白名单（内邀），当前机器人尚未接入',
  // —— 指令面板 /v2/panels 家族（官方文档错误码表）——
  30009: '指令面板操作进行中：存在并发冲突，请稍后重试',
  30011: '生效场景不合法：scope 仅支持 c2c/group/channel/dm',
  30012: '生效范围不合法：target_type 仅支持 all/specific；channel/dm 场景仅支持 all',
  30013: '超出数量限制：请减少请求中的数量（面板元素 ≤20，机器人面板总数 ≤20）',
  30015: '面板元素类型不合法：panel.items[].type 仅支持 command/link',
  30016: '必填字段缺失：面板创建需要 scope 与 panel',
  30018: '当前场景不支持此操作',
  30020: '内容存在安全风险：请修改菜单/面板内容后重试',
  30021: '全局面板不支持添加指定关联对象：请使用 target_type=specific',
}

/** HTTP 状态码层面的通用提示 */
const STATUS_HINTS: Record<number, string> = {
  401: 'AccessToken 无效或已过期（客户端已自动失效缓存，请重试）',
  403: '机器人无此接口权限',
  429: '触发平台限流，请稍后重试',
}

/** QQ 的不同接口使用 code / err_code / biz_code，统一成数字供错误分类。 */
export function apiErrorCode(body: unknown): number | undefined {
  if (!body || typeof body !== 'object') return undefined
  const b = body as Record<string, unknown>
  const value = b.code ?? b.err_code ?? b.biz_code
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return undefined
  const code = Number(value)
  return Number.isFinite(code) ? code : undefined
}

export function apiFailed(status: number, body: unknown): boolean {
  const code = apiErrorCode(body)
  return status <= 0 || status >= 300 || (code !== undefined && code !== 0)
}

/** 50056 是官方的原生 Markdown 权限错误；旧接口有时只返回这句明确拒绝。 */
export function isMarkdownDenied(body: unknown): boolean {
  if (apiErrorCode(body) === 50056) return true
  if (!body || typeof body !== 'object') return false
  const message = (body as { message?: unknown }).message
  return typeof message === 'string' && /不允许发送原生\s*markdown/i.test(message)
}

/**
 * 把平台错误整理成一句可读文案：平台 message 优先，附加已知错误码/状态码说明与错误码原值。
 * 结果型方法（sendMessage 等）用它生成 `SendResult.error`，`QQApiError.message` 也来自这里。
 */
export function describeApiError(status: number, body: unknown, fallback?: string): string {
  const b = (body ?? {}) as { message?: string }
  const errorCode = apiErrorCode(body)
  const hint = (errorCode !== undefined ? CODE_HINTS[errorCode] : undefined) ?? STATUS_HINTS[status]
  const message = b.message ?? fallback ?? `HTTP ${status}`
  const code = errorCode !== undefined ? `（错误码 ${errorCode}）` : ''
  return hint ? `${message}${code}：${hint}` : `${message}${code}`
}

export class QQApiError extends Error {
  readonly status: number
  readonly code: number | undefined
  readonly traceId: string | undefined
  readonly body: unknown

  constructor(status: number, body: unknown, fallback: string, traceId?: string) {
    const b = (body ?? {}) as { trace_id?: string }
    super(describeApiError(status, body, fallback))
    this.name = 'QQApiError'
    this.status = status
    this.code = apiErrorCode(body)
    this.traceId = b.trace_id ?? traceId
    this.body = body
  }
}
