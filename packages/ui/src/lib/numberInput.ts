/**
 * 数字输入框的解析与步进。输入框是普通文本框（不用 type=number：它有系统的上下箭头、滚轮会改值、
 * 超范围时弹浏览器气泡），所以范围、整数这些检查在这里做，错误显示在字段下面。
 */

export interface NumberRules {
  min?: number
  max?: number
  integer?: boolean
}

export type ParsedNumber = { ok: true; value: number | undefined } | { ok: false; error: string }

/** 全角数字、全角负号、中文句号顺手认成半角：中文输入法下常常敲出这些 */
function normalize(text: string): string {
  return text
    .trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[－—–]/g, '-')
    .replace(/[。．]/g, '.')
}

/** 空字符串是「不填」（undefined）；其余必须是合法数字并满足规则 */
export function parseNumber(text: string, rules: NumberRules = {}): ParsedNumber {
  const s = normalize(text)
  if (!s) return { ok: true, value: undefined }
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return { ok: false, error: '请输入数字' }
  const value = Number(s)
  if (!Number.isFinite(value)) return { ok: false, error: '数字太大了' }
  if (rules.integer && !Number.isInteger(value)) return { ok: false, error: '请输入整数' }
  if (rules.min !== undefined && value < rules.min) return { ok: false, error: `不能小于 ${rules.min}` }
  if (rules.max !== undefined && value > rules.max) return { ok: false, error: `不能大于 ${rules.max}` }
  return { ok: true, value }
}

function decimals(n: number): number {
  const s = String(n)
  if (s.includes('e-')) return Number(s.split('e-')[1])
  return s.split('.')[1]?.length ?? 0
}

/** 加减一步并夹在范围里；按两边的小数位取整，免得 0.1 + 0.2 显示成 0.30000000000000004 */
export function stepNumber(value: number, delta: number, rules: NumberRules = {}): number {
  const places = Math.min(10, Math.max(decimals(value), decimals(delta)))
  let next = Number((value + delta).toFixed(places))
  if (rules.min !== undefined) next = Math.max(rules.min, next)
  if (rules.max !== undefined) next = Math.min(rules.max, next)
  return next
}

/** 空着的时候按加减从哪个数开始：有默认值用默认值，没有用 0，都夹在范围里 */
export function stepBase(fallback: number | undefined, rules: NumberRules = {}): number {
  let base = fallback ?? 0
  if (rules.min !== undefined) base = Math.max(rules.min, base)
  if (rules.max !== undefined) base = Math.min(rules.max, base)
  return base
}
