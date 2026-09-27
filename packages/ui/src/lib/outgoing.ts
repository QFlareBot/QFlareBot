/**
 * 调试页把插件的出站消息画成聊天气泡：从 OutgoingMessage（字符串，或 text / image / media / markdown / keyboard / quote）
 * 里拆出要显示的几块。字段与 @qqbot/sdk 的 OutgoingMessage、Keyboard 对应；面板不依赖 sdk，这里只取显示要用的。
 */

export interface PreviewButton {
  id: string
  label: string
  /** 0 灰色线框 · 1 蓝色线框 · 3 白底红字 · 4 蓝底白字 */
  style: number
  /** 0 跳转链接 · 1 回调后台 · 2 指令（填进输入框） */
  action: number
  data: string
  /** 指令按钮：点了直接发送 */
  enter: boolean
}

export interface PreviewMessage {
  text: string | null
  markdown: string | null
  /** 能直接放进 <img src> 的地址：只认 http(s) 与 base64 */
  image: string | null
  media: { type: string; label: string } | null
  keyboard: PreviewButton[][]
  /** 用了平台预设的键盘模板，内容面板看不到 */
  keyboardTemplate: string | null
  quote: boolean
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : null)
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null)

function imageSrc(source: Record<string, unknown> | null): string | null {
  if (!source) return null
  const url = str(source.url)
  if (url && /^https?:\/\//i.test(url)) return url
  const base64 = str(source.base64)
  return base64 ? `data:image/png;base64,${base64}` : null
}

function buttons(keyboard: Record<string, unknown> | null): PreviewButton[][] {
  const rows = obj(keyboard?.content)?.rows
  if (!Array.isArray(rows)) return []
  return rows.map((row) =>
    (Array.isArray(obj(row)?.buttons) ? (obj(row)!.buttons as unknown[]) : []).map((b, i) => {
      const btn = obj(b) ?? {}
      const render = obj(btn.render_data) ?? {}
      const action = obj(btn.action) ?? {}
      return {
        id: str(btn.id) ?? String(i),
        label: str(render.label) ?? '按钮',
        style: typeof render.style === 'number' ? render.style : 0,
        action: typeof action.type === 'number' ? action.type : 1,
        data: str(action.data) ?? '',
        enter: action.enter === true,
      }
    }),
  )
}

export function previewMessage(message: unknown): PreviewMessage {
  if (typeof message === 'string') {
    return { text: message, markdown: null, image: null, media: null, keyboard: [], keyboardTemplate: null, quote: false }
  }
  const m = obj(message) ?? {}
  const media = obj(m.media)
  const keyboard = obj(m.keyboard)
  const mediaType = str(media?.type)
  return {
    text: str(m.text),
    markdown: str(obj(m.markdown)?.content) ?? (obj(m.markdown)?.customTemplateId ? `（markdown 模板 ${String(obj(m.markdown)!.customTemplateId)}）` : null),
    image: imageSrc(obj(m.image)) ?? (mediaType === 'image' ? imageSrc(media) : null),
    media:
      media && mediaType !== 'image'
        ? { type: mediaType ?? 'file', label: str(media.filename) ?? str(media.url) ?? (media.base64 ? '（base64 直传）' : '') }
        : null,
    keyboard: buttons(keyboard),
    keyboardTemplate: str(keyboard?.id),
    quote: m.quote === true || typeof m.quote === 'string',
  }
}
