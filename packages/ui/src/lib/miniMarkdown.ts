/**
 * 调试页预览 QQ markdown 用的极简解析：代码块、标题、引用、列表、分隔线，行内的代码、粗体、斜体、链接、图片。
 * 只产出结构，由模板渲染成节点——不拼 HTML，插件回复里的内容不会被当成标签执行。
 * 链接和图片只认 http(s)；QQ 图片语法里的尺寸（![描述 #208px #320px](url)）从描述里去掉。
 */

export type Inline =
  | { t: 'text' | 'code' | 'bold' | 'italic'; v: string }
  | { t: 'link'; v: string; href: string }
  | { t: 'image'; alt: string; src: string }

export type Block =
  | { t: 'p' | 'quote'; inl: Inline[] }
  | { t: 'h'; level: number; inl: Inline[] }
  | { t: 'li'; marker: string; inl: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'hr' }

const safeUrl = (u: string): string | null => (/^https?:\/\//i.test(u) ? u : null)

const INLINE = /(`[^`\n]+`)|(!\[[^\]\n]*\]\([^)\s]+\))|(\[[^\]\n]+\]\([^)\s]+\))|(\*\*[^*\n]+\*\*)|(\*[^*\s\n][^*\n]*\*)/g

export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push({ t: 'text', v: text.slice(last, m.index) })
    const s = m[0]
    if (m[1]) out.push({ t: 'code', v: s.slice(1, -1) })
    else if (m[2] || m[3]) {
      const image = !!m[2]
      const close = s.indexOf('](')
      const label = s.slice(image ? 2 : 1, close)
      const url = safeUrl(s.slice(close + 2, -1))
      if (!url) out.push({ t: 'text', v: label })
      else if (image) out.push({ t: 'image', alt: label.replace(/\s*#\d+px/g, '').trim(), src: url })
      else out.push({ t: 'link', v: label, href: url })
    } else if (m[4]) out.push({ t: 'bold', v: s.slice(2, -2) })
    else out.push({ t: 'italic', v: s.slice(1, -1) })
    last = m.index + s.length
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) })
  return out
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let para: string[] = []
  const flush = () => {
    if (para.length) blocks.push({ t: 'p', inl: parseInline(para.join('\n')) })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (/^\s*```/.test(line)) {
      flush()
      const code: string[] = []
      while (++i < lines.length && !/^\s*```/.test(lines[i]!)) code.push(lines[i]!)
      blocks.push({ t: 'code', v: code.join('\n') })
      continue
    }
    let m: RegExpExecArray | null
    if (!line.trim()) flush()
    else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      flush()
      blocks.push({ t: 'h', level: m[1]!.length, inl: parseInline(m[2]!) })
    } else if (/^\s*(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) {
      flush()
      blocks.push({ t: 'hr' })
    } else if ((m = /^>\s?(.*)$/.exec(line))) {
      flush()
      blocks.push({ t: 'quote', inl: parseInline(m[1]!) })
    } else if ((m = /^\s*(?:([-*+])|(\d+)\.)\s+(.*)$/.exec(line))) {
      flush()
      blocks.push({ t: 'li', marker: m[2] ? `${m[2]}.` : '•', inl: parseInline(m[3]!) })
    } else para.push(line)
  }
  flush()
  return blocks
}
