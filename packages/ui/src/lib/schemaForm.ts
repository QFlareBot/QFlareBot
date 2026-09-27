/**
 * SchemaForm 里不依赖 Vue 的那部分：枚举下拉的取值映射、JSON 文本框的解析。拆出来是为了能单测。
 */

/** 与运行时校验同一个比较（configSchema.ts 用 Array.prototype.includes，即 SameValueZero） */
function sameValueZero(a: unknown, b: unknown): boolean {
  return a === b || (a !== a && b !== b)
}

/** 当前值在 enum 里的下标；不在里面为 -1 */
export function enumIndex(values: readonly unknown[], value: unknown): number {
  return values.findIndex((v) => sameValueZero(v, value))
}

/**
 * 枚举下拉的选项，value 用下标：<select> 只能回传字符串，直接用 String(v) 当 value 的话，
 * 数字 / 布尔枚举会以 "2" / "true" 写回，运行时严格比较不认，保存必然 400。
 */
export function enumOptions(values: readonly unknown[]): Array<{ value: string; label: string }> {
  return values.map((v, i) => ({ value: String(i), label: typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v)) }))
}

/** 下拉回传的下标 → enum 里的原始值 */
export function enumValueAt(values: readonly unknown[], index: string): unknown {
  return values[Number(index)]
}

export type JsonDraft = { ok: true; value: unknown } | { ok: false; error: string }

/** JSON 文本框的内容；清空等于不设这一项 */
export function parseJsonDraft(text: string): JsonDraft {
  if (!text.trim()) return { ok: true, value: undefined }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false, error: '不是合法的 JSON' }
  }
}
