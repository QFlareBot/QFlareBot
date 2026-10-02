import type {
  BotApi,
  BotProfile,
  GroupApi,
  ImageSource,
  InteractionCode,
  MediaSource,
  OutgoingMessage,
  Scene,
  SendOptions,
  SendResult,
  SendTarget,
  StreamChunkOptions,
  UploadedMedia,
} from '@qqbot/sdk'
import { apiErrorCode, apiFailed, describeApiError, isMarkdownDenied, QQApiError } from './errors.js'
import { REQUEST_BUDGET_MS, requestJson, type JsonResponse } from './request.js'
import { createGroupApi } from './group.js'
import { createTokenProvider, type TokenCache, type TokenProvider } from './token.js'
import { FileType, MsgType } from './types.js'

/** 2026-08 起平台统一域名；旧的 api.sgroup.qq.com 仍可用 */
export const DEFAULT_BASE_URL = 'https://api.bot.qq.com'

export interface QQBotClientOptions {
  appId: string
  secret: string
  tokenCache?: TokenCache
  tokenProvider?: TokenProvider
  fetchImpl?: typeof fetch
  baseUrl?: string
  /** 每次 sendMessage 得到结果后调用（成败都调）；运行时用它记下机器人发出消息的 ref index → 消息 id */
  onSent?: (target: SendTarget, result: SendResult) => void
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** 各场景的消息与文件端点；频道场景没有 /files，图片走消息体里的 image URL */
function messagePath(target: SendTarget): string {
  switch (target.scene) {
    case 'group':
      return `/v2/groups/${target.id}/messages`
    case 'c2c':
      return `/v2/users/${target.id}/messages`
    case 'guild':
      return `/channels/${target.id}/messages`
    case 'guild_dm':
      return `/dms/${target.id}/messages`
    default:
      throw new Error(`场景 ${target.scene} 无法发送消息`)
  }
}

function filesPath(target: SendTarget): string {
  switch (target.scene) {
    case 'group':
      return `/v2/groups/${target.id}/files`
    case 'c2c':
      return `/v2/users/${target.id}/files`
    default:
      throw new Error(`场景 ${target.scene} 不支持富媒体上传`)
  }
}

function isV2Scene(scene: Scene): boolean {
  return scene === 'group' || scene === 'c2c'
}

function normalizeMessage(message: OutgoingMessage): Exclude<OutgoingMessage, string> {
  return typeof message === 'string' ? { text: message } : message
}

function toMedia(media: MediaSource | ImageSource): MediaSource {
  return 'type' in media ? media : { type: 'image', ...media }
}

type SendResponse = { id?: string; message?: string; trace_id?: string; ext_info?: { ref_idx?: string } }

function toSendResult(res: JsonResponse & { error?: string }): SendResult {
  const data = res.data as SendResponse | null
  const ok = res.error === undefined && !apiFailed(res.status, data)
  const result: SendResult = { ok, status: res.status, raw: res.data }
  if (data?.id) result.messageId = data.id
  if (data?.ext_info?.ref_idx) result.refIndex = data.ext_info.ref_idx
  const code = apiErrorCode(res.data)
  if (code !== undefined) result.code = code
  const traceId = data?.trace_id ?? res.traceId
  if (traceId) result.traceId = traceId
  if (!ok) result.error = res.error ?? describeApiError(res.status, res.data)
  return result
}

function failedRequest(error: unknown): JsonResponse & { error: string } {
  return {
    status: error instanceof QQApiError ? error.status : 0,
    data: error instanceof QQApiError ? error.body : null,
    ...(error instanceof QQApiError && error.traceId ? { traceId: error.traceId } : {}),
    error: error instanceof Error ? error.message : String(error),
  }
}

/** 被动回复凭据：msg_id / event_id / is_wakeup 三者互斥 */
function passiveFields(options: SendOptions): Record<string, unknown> {
  if (options.wakeup) return { is_wakeup: true }
  if (options.messageId) return { msg_id: options.messageId, msg_seq: options.msgSeq ?? 1 }
  if (options.eventId) return { event_id: options.eventId, msg_seq: options.msgSeq ?? 1 }
  return {}
}

export class QQBotClient implements BotApi {
  readonly appId: string
  readonly group: GroupApi
  private readonly tokens: TokenProvider
  private readonly fetchImpl: typeof fetch
  private readonly baseUrl: string
  private readonly onSent: QQBotClientOptions['onSent']

  constructor(options: QQBotClientOptions) {
    this.appId = options.appId
    this.onSent = options.onSent
    // 不能把全局 fetch 直接存成属性再 this.fetchImpl() 调用：workerd 会因 this 不是全局对象抛 Illegal invocation
    const impl = options.fetchImpl ?? fetch
    this.fetchImpl = (input, init) => impl(input, init)
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
    this.tokens =
      options.tokenProvider ??
      createTokenProvider({
        appId: options.appId,
        secret: options.secret,
        fetchImpl: this.fetchImpl,
        ...(options.tokenCache ? { cache: options.tokenCache } : {}),
      })
    this.group = createGroupApi(this)
  }

  async raw<T = unknown>(method: HttpMethod, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const res = await this.request(method, path, body)
    return { status: res.status, data: res.data as T }
  }

  private request(method: HttpMethod, path: string, body?: unknown, deadline?: number): Promise<JsonResponse> {
    const b = (body ?? {}) as Record<string, unknown>
    // 消息重试沿用原 msg_id/event_id + msg_seq；主动消息和通用写操作没有去重凭据，不重放。
    const message = method === 'POST' && /\/messages$/.test(path) &&
      !!(b.msg_id || b.event_id) && typeof b.msg_seq === 'number'
    // append 流在网络中断时无法确认分片是否已追加，交给流状态机停止，避免重复文本。
    const upload = method === 'POST' && /\/files$/.test(path) && b.srv_send_msg === false
    const json = body === undefined ? null : JSON.stringify(body)
    return requestJson(this.fetchImpl, this.baseUrl + path, async (refreshToken) => {
      if (refreshToken) await this.tokens.invalidate()
      const token = await this.tokens.get()
      return {
        method,
        headers: {
          authorization: `QQBot ${token}`,
          'content-type': 'application/json',
          'x-union-appid': this.appId,
        },
        body: json,
      }
    }, { retry: method === 'GET' || message || upload, refreshToken: true, ...(deadline !== undefined ? { deadline } : {}) })
  }

  /** raw 的兜底版本：token 获取失败等异常转成失败结果，供返回 SendResult 的方法使用 */
  private async safeRaw(method: HttpMethod, path: string, body?: unknown, deadline?: number): Promise<JsonResponse & { error?: string }> {
    try {
      return await this.request(method, path, body, deadline)
    } catch (err) {
      return failedRequest(err)
    }
  }

  /** raw 的抛错版本：HTTP 或业务错误抛 QQApiError */
  async call<T = unknown>(method: HttpMethod, path: string, body?: unknown, what = path): Promise<T> {
    const { status, data, traceId } = await this.request(method, path, body)
    if (apiFailed(status, data)) throw new QQApiError(status, data, `${what} 失败 (HTTP ${status})`, traceId)
    return data as T
  }

  /** 机器人自身资料（GET /users/@me）；调用频率由插件自己控制，框架不做缓存 */
  async me(): Promise<BotProfile> {
    return this.call<BotProfile>('GET', '/users/@me', undefined, '获取机器人资料')
  }

  async uploadMedia(target: SendTarget, source: MediaSource | ImageSource): Promise<UploadedMedia> {
    return this.upload(target, source, Date.now() + REQUEST_BUDGET_MS)
  }

  private async upload(target: SendTarget, source: MediaSource | ImageSource, deadline: number): Promise<UploadedMedia> {
    const media = toMedia(source)
    if (!media.url && !media.base64) throw new Error('富媒体需提供 url 或 base64')
    const body: Record<string, unknown> = {
      file_type: FileType[media.type],
      srv_send_msg: false,
      ...(media.url ? { url: media.url } : { file_data: media.base64 }),
    }
    if (media.filename) body.file_name = media.filename

    const res = await this.request('POST', filesPath(target), body, deadline)
    if (apiFailed(res.status, res.data)) throw new QQApiError(res.status, res.data, '上传富媒体失败', res.traceId)
    const data = res.data as { file_info?: string; file_uuid?: string; ttl?: number } | null
    if (!data?.file_info) throw new QQApiError(res.status, data, '上传富媒体未返回 file_info', res.traceId)
    return { fileInfo: data.file_info, fileUuid: data.file_uuid ?? '', ttl: data.ttl ?? 0 }
  }

  async sendMessage(target: SendTarget, message: OutgoingMessage, options: SendOptions = {}): Promise<SendResult> {
    const deadline = Date.now() + REQUEST_BUDGET_MS
    const msg = normalizeMessage(message)
    const body: Record<string, unknown> = {}
    const media = msg.media ?? (msg.image ? toMedia(msg.image) : undefined)

    if (isV2Scene(target.scene)) {
      if (media) {
        let uploaded: UploadedMedia
        try {
          uploaded = await this.upload(target, media, deadline)
        } catch (err) {
          return toSendResult(failedRequest(err))
        }
        body.msg_type = MsgType.Media
        body.media = { file_info: uploaded.fileInfo }
        if (msg.text) body.content = msg.text
      } else if (msg.markdown || msg.keyboard) {
        // 键盘只能挂在 markdown 消息上；只给文本时自动升级
        const md = msg.markdown ?? {}
        body.msg_type = MsgType.Markdown
        const markdown: Record<string, unknown> = {}
        const content = md.content ?? msg.text
        if (content !== undefined) markdown.content = content
        if (md.customTemplateId) markdown.custom_template_id = md.customTemplateId
        if (md.params) markdown.params = md.params
        if (md.forceVerifyImage) markdown.force_verify_image_resource = true
        body.markdown = markdown
        if (msg.keyboard) body.keyboard = msg.keyboard
      } else {
        body.msg_type = MsgType.Text
        body.content = msg.text ?? ' '
      }
      if (typeof msg.quote === 'string') body.message_reference = { message_id: msg.quote }
      Object.assign(body, passiveFields(options))
    } else {
      if (msg.text) body.content = msg.text
      if (media?.url) body.image = media.url
      if (msg.markdown) body.markdown = msg.markdown
      if (msg.keyboard) body.keyboard = msg.keyboard
      if (typeof msg.quote === 'string') body.message_reference = { message_id: msg.quote }
      if (options.messageId) body.msg_id = options.messageId
      else if (options.eventId) body.event_id = options.eventId
    }

    const path = messagePath(target)
    let response = await this.safeRaw('POST', path, body, deadline)
    const markdown = body.markdown as { content?: string } | undefined
    // 只在明确的原生 Markdown 权限拒绝时降级；键盘/模板不能静默丢失交互或内容。
    if (apiFailed(response.status, response.data) && isMarkdownDenied(response.data) &&
      !msg.keyboard && !msg.markdown?.customTemplateId && markdown?.content) {
      const fallback = { ...body }
      delete fallback.markdown
      fallback.content = msg.text || markdown.content
      if (isV2Scene(target.scene)) fallback.msg_type = MsgType.Text
      response = await this.safeRaw('POST', path, fallback, deadline)
    }
    const result = toSendResult(response)
    this.onSent?.(target, result)
    return result
  }

  async typing(userOpenid: string, seconds = 10, options: SendOptions = {}): Promise<SendResult> {
    return toSendResult(
      await this.safeRaw('POST', `/v2/users/${userOpenid}/messages`, {
        msg_type: MsgType.InputNotify,
        input_notify: { input_type: 1, input_second: Math.min(60, Math.max(1, Math.round(seconds))) },
        ...passiveFields(options),
      }),
    )
  }

  async streamChunk(userOpenid: string, content: string, options: StreamChunkOptions): Promise<SendResult> {
    const body: Record<string, unknown> = {
      input_mode: 'append',
      input_state: options.final ? 10 : 1,
      index: options.index,
      content_type: options.markdown ? 'markdown' : 'text',
      content_raw: content,
      ...passiveFields(options),
    }
    if (options.streamId) body.stream_msg_id = options.streamId
    const result = toSendResult(await this.safeRaw('POST', `/v2/users/${userOpenid}/stream_messages`, body))
    this.onSent?.({ scene: 'c2c', id: userOpenid }, result)
    return result
  }

  async recallMessage(target: SendTarget, messageId: string): Promise<boolean> {
    const path =
      target.scene === 'group'
        ? `/v2/groups/${target.id}/messages/${messageId}`
        : target.scene === 'c2c'
          ? `/v2/users/${target.id}/messages/${messageId}`
          : target.scene === 'guild'
            ? `/channels/${target.id}/messages/${messageId}?hidetip=true`
            : null
    if (!path) return false
    const { status, data, error } = await this.safeRaw('DELETE', path)
    return error === undefined && !apiFailed(status, data)
  }

  async ackInteraction(interactionId: string, code: InteractionCode = 0): Promise<boolean> {
    const { status, data, error } = await this.safeRaw('PUT', `/interactions/${interactionId}`, { code })
    return error === undefined && !apiFailed(status, data)
  }
}
