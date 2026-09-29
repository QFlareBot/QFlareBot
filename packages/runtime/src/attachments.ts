import type { RawAttachment } from '@qqbot/api'
import type { Attachment } from '@qqbot/sdk'

/** 推送里的附件转成 SDK 的形状；平台给的 url 有时不带协议，补上 https */
export function toAttachments(list: RawAttachment[] | undefined): Attachment[] {
  return (Array.isArray(list) ? list : [])
    .filter((a) => typeof a?.url === 'string')
    .map((a) => {
      const url = a.url!.startsWith('http') ? a.url! : `https://${a.url}`
      const item: Attachment = { url }
      if (a.content_type) item.contentType = a.content_type
      if (a.filename) item.filename = a.filename
      if (a.width) item.width = a.width
      if (a.height) item.height = a.height
      if (a.size) item.size = a.size
      return item
    })
}
