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

/**
 * 把平台错误整理成一句可读文案：平台 message 优先，附加已知错误码/状态码说明与错误码原值。
 * 结果型方法（sendMessage 等）用它生成 `SendResult.error`，`QQApiError.message` 也来自这里。
 */
export function describeApiError(status: number, body: unknown, fallback?: string): string {
  const b = (body ?? {}) as { message?: string; code?: number }
  const hint = (b.code !== undefined ? CODE_HINTS[b.code] : undefined) ?? STATUS_HINTS[status]
  const message = b.message ?? fallback ?? `HTTP ${status}`
  const code = b.code !== undefined ? `（错误码 ${b.code}）` : ''
  return hint ? `${message}${code}：${hint}` : `${message}${code}`
}

export class QQApiError extends Error {
  readonly status: number
  readonly code: number | undefined
  readonly traceId: string | undefined
  readonly body: unknown

  constructor(status: number, body: unknown, fallback: string) {
    const b = (body ?? {}) as { code?: number; trace_id?: string }
    super(describeApiError(status, body, fallback))
    this.name = 'QQApiError'
    this.status = status
    this.code = b.code
    this.traceId = b.trace_id
    this.body = body
  }
}
