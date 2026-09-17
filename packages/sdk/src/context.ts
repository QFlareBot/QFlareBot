import type { OutgoingMessage, SendResult, SendTarget, ImageSource } from './session.js'

export type Awaitable<T> = T | Promise<T>

export interface Logger {
  debug(message: string, data?: unknown): void
  info(message: string, data?: unknown): void
  warn(message: string, data?: unknown): void
  error(message: string, data?: unknown): void
}

/** 按插件名自动加前缀的 KV，插件之间互不可见 */
export interface ScopedKV {
  get(key: string): Promise<string | null>
  getJSON<T = unknown>(key: string): Promise<T | null>
  put(key: string, value: string | object, options?: { ttl?: number }): Promise<void>
  delete(key: string): Promise<void>
  list(prefix?: string): Promise<string[]>
}

/** 按插件名加表前缀的 D1；`table('x')` 返回真实表名，SQL 中请用它拼接 */
export interface ScopedDB {
  table(name: string): string
  exec(sql: string): Promise<void>
  run(sql: string, ...params: unknown[]): Promise<{ changes: number }>
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>
  first<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | null>
}

export interface UploadedMedia {
  fileInfo: string
  fileUuid: string
  ttl: number
}

/** QQ OpenAPI 访问口。`raw` 永远可用，框架未封装的接口直接调它 */
export interface BotApi {
  raw<T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T }>
  sendMessage(
    target: SendTarget,
    message: OutgoingMessage,
    options?: { messageId?: string; msgSeq?: number },
  ): Promise<SendResult>
  uploadMedia(target: SendTarget, image: ImageSource): Promise<UploadedMedia>
}

/**
 * 运行时注入给插件的全部能力。插件不 import 运行时，只用这里的对象。
 * 新增能力优先做成服务（`service()`），而不是往这里加固定字段。
 */
export interface PluginContext<C = unknown> {
  readonly plugin: { readonly name: string; readonly version: string }
  readonly botId: string
  readonly config: C
  readonly logger: Logger
  readonly kv: ScopedKV
  readonly db: ScopedDB
  readonly api: BotApi
  /** 取其他插件提供的服务；未提供时抛错 */
  service<T = unknown>(name: string): T
  /** 让后台任务在响应返回后继续执行 */
  waitUntil(promise: Promise<unknown>): void
}
