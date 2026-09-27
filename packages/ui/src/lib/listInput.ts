/** 逐条输入列表（QListInput）用到的纯函数 */

/**
 * 粘贴进来的一段文字拆成多条。
 * - `line`：只按换行拆（插件配置里的字符串可能本身带空格、逗号）
 * - `any`：换行、空格、中英文逗号都算分隔（openid、群 ID 这类不含空白的值）
 */
export function splitList(text: string, mode: 'line' | 'any' = 'line'): string[] {
  const parts = mode === 'any' ? text.split(/[\s,，]+/) : text.split(/\r?\n/)
  return parts.map((s) => s.trim()).filter(Boolean)
}

/** 编辑中的各行 → 要保存的值：去掉首尾空白与空行 */
export function cleanList(values: readonly string[]): string[] {
  return values.map((v) => v.trim()).filter(Boolean)
}

export function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}
