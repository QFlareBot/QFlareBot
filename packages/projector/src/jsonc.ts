/**
 * 去掉 `//`、`/* *\/` 注释与尾随逗号（字符串内不处理）。
 * 注释替换为空白以保留行列位置，便于 JSON.parse 报错定位。
 */
export function stripJsonComments(text: string): string {
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i] as string
    if (ch === '"') {
      let j = i + 1
      while (j < n && text[j] !== '"') {
        if (text[j] === '\\') j++
        j++
      }
      out += text.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      let j = i
      while (j < n && text[j] !== '\n') j++
      out += ' '.repeat(j - i)
      i = j
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      const j = end === -1 ? n : end + 2
      out += text.slice(i, j).replace(/[^\n]/g, ' ')
      i = j
      continue
    }
    if (ch === ',') {
      let j = i + 1
      while (j < n && /\s/.test(text[j] as string)) j++
      if (text[j] === '}' || text[j] === ']') {
        out += ' '
        i++
        continue
      }
    }
    out += ch
    i++
  }
  return out
}

export function parseJsonc<T = unknown>(text: string): T {
  return JSON.parse(stripJsonComments(text)) as T
}
