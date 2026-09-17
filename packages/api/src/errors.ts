export class QQApiError extends Error {
  readonly status: number
  readonly code: number | undefined
  readonly traceId: string | undefined
  readonly body: unknown

  constructor(status: number, body: unknown, fallback: string) {
    const b = (body ?? {}) as { message?: string; code?: number; trace_id?: string }
    super(b.message ?? fallback)
    this.name = 'QQApiError'
    this.status = status
    this.code = b.code
    this.traceId = b.trace_id
    this.body = body
  }
}
