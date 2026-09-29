/**
 * 配置表单里「和谁比」的那部分：改过没有（和已保存的比）、能不能恢复默认（和出厂默认比）、
 * 某个字段此刻该不该显示（x-showIf）。不依赖 Vue，能单测。
 */
import type { JsonSchema } from '../api/types.js'

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** 深比较：对象不看键的顺序，数组看顺序；值为 undefined 的键等于没有这个键 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b || (a !== a && b !== b)) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => sameValue(v, b[i]))
  }
  if (!isRecord(a) || !isRecord(b)) return false
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) if (!sameValue(a[k], b[k])) return false
  return true
}

/**
 * 子字段的出厂默认：插件 defaultConfig 里这一层有这个键就用它，否则用 schema 里的 default。
 * 与运行时的合并规则一致——没保存过的字段取的就是 defaultConfig 里的值。
 */
export function childDefault(defaults: unknown, key: string, schema: JsonSchema): unknown {
  if (isRecord(defaults) && Object.hasOwn(defaults, key)) return defaults[key]
  return schema.default
}

/**
 * x-showIf：`{ 同级字段: 期望值 }`，每一条都满足才显示；期望值写成数组表示「等于其中任意一个」。
 * 没写就一直显示。与 packages/runtime/src/configSchema.ts 的 isShown 是同一个约定，两边必须一致：
 * 隐藏的字段不校验，面板上也就不该拦着它。
 */
export function isShown(schema: JsonSchema, siblings: unknown): boolean {
  const cond = schema['x-showIf']
  if (!isRecord(cond)) return true
  const values = isRecord(siblings) ? siblings : {}
  return Object.entries(cond).every(([key, expected]) => {
    const actual = Object.hasOwn(values, key) ? values[key] : undefined
    return Array.isArray(expected) ? expected.some((e) => sameValue(e, actual)) : sameValue(expected, actual)
  })
}
