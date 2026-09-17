import type { BotApi, ImageSource, OutgoingMessage, Scene, SendResult, SendTarget, UploadedMedia } from '@qqbot/sdk'
import { QQApiError } from './errors.js'
import { createTokenProvider, type TokenCache, type TokenProvider } from './token.js'
import { FileType, MsgType } from './types.js'

export interface QQBotClientOptions {
  appId: string
  secret: string
  tokenCache?: TokenCache
  tokenProvider?: TokenProvider
  fetchImpl?: typeof fetch
  baseUrl?: string
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

export class QQBotClient implements BotApi {
  readonly appId: string
  private readonly tokens: TokenProvider
  private readonly fetchImpl: typeof fetch
  private readonly baseUrl: string

  constructor(options: QQBotClientOptions) {
    this.appId = options.appId
    this.fetchImpl = options.fetchImpl ?? fetch
    this.baseUrl = options.baseUrl ?? 'https://api.sgroup.qq.com'
    this.tokens =
      options.tokenProvider ??
      createTokenProvider({
        appId: options.appId,
        secret: options.secret,
        fetchImpl: this.fetchImpl,
        ...(options.tokenCache ? { cache: options.tokenCache } : {}),
      })
  }

  async raw<T = unknown>(method: HttpMethod, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const token = await this.tokens.get()
    const res = await this.fetchImpl(this.baseUrl + path, {
      method,
      headers: {
        authorization: `QQBot ${token}`,
        'content-type': 'application/json',
        'x-union-appid': this.appId,
      },
      body: body === undefined ? null : JSON.stringify(body),
    })
    const text = await res.text()
    let data: unknown = null
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        data = { raw: text }
      }
    }
    // token 失效时刷新一次再重试
    if (res.status === 401) {
      await this.tokens.invalidate()
    }
    return { status: res.status, data: data as T }
  }

  async uploadMedia(target: SendTarget, image: ImageSource): Promise<UploadedMedia> {
    if (!image.url && !image.base64) throw new Error('图片需提供 url 或 base64')
    const { status, data } = await this.raw<{ file_info?: string; file_uuid?: string; ttl?: number }>(
      'POST',
      filesPath(target),
      {
        file_type: FileType.Image,
        ...(image.url ? { url: image.url } : { file_data: image.base64 }),
        srv_send_msg: false,
      },
    )
    if (status >= 300 || !data?.file_info) {
      throw new QQApiError(status, data, `上传富媒体失败 (HTTP ${status})`)
    }
    return { fileInfo: data.file_info, fileUuid: data.file_uuid ?? '', ttl: data.ttl ?? 0 }
  }

  async sendMessage(
    target: SendTarget,
    message: OutgoingMessage,
    options: { messageId?: string; msgSeq?: number } = {},
  ): Promise<SendResult> {
    const msg = normalizeMessage(message)
    const body: Record<string, unknown> = {}

    if (isV2Scene(target.scene)) {
      if (msg.image) {
        const media = await this.uploadMedia(target, msg.image)
        body.msg_type = MsgType.Media
        body.media = { file_info: media.fileInfo }
        body.content = msg.text ?? ' '
      } else if (msg.markdown) {
        body.msg_type = MsgType.Markdown
        body.markdown = msg.markdown
        if (msg.keyboard) body.keyboard = msg.keyboard
      } else {
        body.msg_type = MsgType.Text
        body.content = msg.text ?? ' '
      }
      if (options.messageId) {
        body.msg_id = options.messageId
        body.msg_seq = options.msgSeq ?? 1
      }
    } else {
      if (msg.text) body.content = msg.text
      if (msg.image?.url) body.image = msg.image.url
      if (msg.markdown) body.markdown = msg.markdown
      if (msg.keyboard) body.keyboard = msg.keyboard
      if (options.messageId) body.msg_id = options.messageId
    }

    const { status, data } = await this.raw<{ id?: string; message?: string }>('POST', messagePath(target), body)
    const ok = status < 300
    const result: SendResult = { ok, status, raw: data }
    if (data?.id) result.messageId = data.id
    if (!ok) result.error = data?.message ?? `HTTP ${status}`
    return result
  }
}
