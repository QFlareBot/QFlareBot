/** 从 text[i]（一个 `"`）开始扫到字符串结束，返回结束引号之后的下标；未闭合时返回 text.length */
function skipString(text: string, i: number): number {
  let j = i + 1
  while (j < text.length && text[j] !== '"') {
    if (text[j] === '\\') j++
    j++
  }
  return Math.min(j + 1, text.length)
}

/** 去掉 `//`、`/* *\/` 注释（字符串内不处理），注释替换为空白以保留行列位置，便于 JSON.parse 报错定位 */
function stripComments(text: string): string {
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i] as string
    if (ch === '"') {
      const j = skipString(text, i)
      out += text.slice(i, j)
      i = j
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
    out += ch
    i++
  }
  return out
}

/**
 * 去掉尾随逗号（字符串内不处理），逗号换成一个空格，行列位置不变。
 *
 * 必须在去完注释**之后**单独扫一遍：逗号与 `]` / `}` 之间隔着注释（`[1, // 说明\n]`）是很常见的写法——
 * 照提示往 wrangler.jsonc 的 migrations 里补一项时就容易这样写。一遍扫完的话，看到逗号时后面还是注释，
 * 认不出它是尾随的，JSON.parse 随即报错。
 */
function stripTrailingCommas(text: string): string {
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i] as string
    if (ch === '"') {
      const j = skipString(text, i)
      out += text.slice(i, j)
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

/**
 * 去掉 `//`、`/* *\/` 注释与尾随逗号（字符串内不处理）。
 * 注释替换为空白以保留行列位置，便于 JSON.parse 报错定位。
 */
export function stripJsonComments(text: string): string {
  return stripTrailingCommas(stripComments(text))
}

export function parseJsonc<T = unknown>(text: string): T {
  return JSON.parse(stripJsonComments(text)) as T
}
