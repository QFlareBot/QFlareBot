/**
 * SchemaForm 里不依赖 Vue 的那部分：字段怎么渲染（kind）、路径、不可变更新、下拉取值映射、
 * JSON 文本框解析、映射（键值对）的校验、密钥占位。拆出来是为了能单测。
 */
import type { JsonSchema } from '../api/types.js'

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

/**
 * oneOf / anyOf 里每一项都是 const 时当成带标签的枚举：返回各项的原始值与标签，否则 null。
 * 下拉仍按下标选（同 enumOptions 的理由），写回的是 const 原值。
 */
export function constChoices(s: JsonSchema): { values: unknown[]; labels: string[] } | null {
  const list = s.oneOf ?? s.anyOf
  if (!Array.isArray(list) || !list.length || !list.every((o) => o && typeof o === 'object' && 'const' in o)) return null
  return { values: list.map((o) => o.const), labels: list.map((o) => o.title ?? String(o.const)) }
}

/** 多选：数组的 items 是 enum 或全是 const 的 oneOf，返回可选的值与标签，否则 null */
export function multiChoices(s: JsonSchema): { values: unknown[]; labels: string[] } | null {
  if (s.type !== 'array' || !s.items) return null
  const items = s.items
  if (Array.isArray(items.enum) && items.enum.length) return { values: items.enum, labels: enumOptions(items.enum).map((o) => o.label) }
  return constChoices(items)
}

export type FieldKind =
  | 'const'
  | 'enum'
  | 'secret'
  | 'textarea'
  | 'string'
  | 'number'
  | 'boolean'
  | 'multi'
  | 'string[]'
  | 'object'
  | 'object[]'
  | 'map'
  | 'json'

const isObjectSchema = (s: JsonSchema | undefined) => !!s && (s.type === 'object' || (s.type === undefined && !!s.properties))

/** 按 schema 选输入控件；认不出来的一律退回 JSON 文本框 */
export function fieldKind(s: JsonSchema): FieldKind {
  if (constChoices(s)) return 'const'
  if (s.enum) return 'enum'
  if (s.type === 'string') return s.writeOnly ? 'secret' : s.format === 'textarea' ? 'textarea' : 'string'
  if (s.type === 'number' || s.type === 'integer') return 'number'
  if (s.type === 'boolean') return 'boolean'
  if (s.type === 'array') {
    if (multiChoices(s)) return 'multi'
    if (s.items?.type === 'string') return 'string[]'
    if (isObjectSchema(s.items) && Object.keys(s.items?.properties ?? {}).length) return 'object[]'
    return 'json'
  }
  if (isObjectSchema(s)) {
    if (Object.keys(s.properties ?? {}).length) return 'object'
    const extra = s.additionalProperties
    if (extra === true || (extra && typeof extra === 'object')) return 'map'
  }
  return 'json'
}

/** 这几种自己就是一组输入，外面套分组而不是单个 label */
export const isGroupKind = (k: FieldKind) => k === 'object' || k === 'object[]' || k === 'map' || k === 'multi'

/**
 * 映射里「值」的 schema。additionalProperties: true 时按字符串编辑；
 * 但已有的值不是字符串的，退回 JSON，免得存一次就把数字、对象改成了字符串。
 */
export function mapValueSchema(s: JsonSchema, value: unknown): JsonSchema {
  const extra = s.additionalProperties
  if (extra && typeof extra === 'object') return extra
  return value === undefined || typeof value === 'string' ? { type: 'string' } : {}
}

// ---- 路径：与服务端校验错误的 path 同一套写法——点分、数组下标从 0 起、顶层就是键名本身 ----

export function joinPath(parent: string, seg: string | number): string {
  return parent ? `${parent}.${seg}` : String(seg)
}

/** DOM id：沿用老的 cfg-键名，嵌套往后接；空白换掉，不然 aria-describedby 会拆成两个 id */
export function joinId(parent: string, seg: string | number): string {
  return `${parent}-${String(seg).replace(/[\s.]+/g, '-')}`
}

/**
 * 把路径念给用户听：给了 schema 就换成各级 title，数组下标换成「第 n 项」；没给就原样返回。
 * 映射的键原样保留。含「.」的键会被拆开——与服务端同样按点拼接，只影响显示。
 */
export function fieldLabel(path: string, schema?: JsonSchema): string {
  if (!schema || !path) return path
  const out: string[] = []
  let cur: JsonSchema | undefined = schema
  for (const seg of path.split('.')) {
    const prop = getOwn(cur?.properties, seg)
    if (cur?.type === 'array' && /^\d+$/.test(seg)) {
      out.push(`第 ${Number(seg) + 1} 项`)
      cur = cur.items
    } else if (prop) {
      out.push(prop.title ?? seg)
      cur = prop
    } else {
      out.push(seg)
      const extra = cur?.additionalProperties
      cur = extra && typeof extra === 'object' ? extra : undefined
    }
  }
  return out.join(' › ')
}

// ---- 不可变更新 ----

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export function asRecord(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {}
}

/** 只取自有属性：键叫 constructor、toString 时直接 obj[key] 会拿到原型上的函数 */
export function getOwn<T>(obj: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return obj && Object.hasOwn(obj, key) ? obj[key] : undefined
}

/**
 * 按路径写入并返回新值，原对象不动。中间缺的层按下一段是数字还是字符串补数组或对象。
 * 对象上写 undefined 等于删掉这个键（清空的数字框不留一个空键）。
 */
export function setIn(target: unknown, path: readonly (string | number)[], value: unknown): unknown {
  if (!path.length) return value
  const [head, ...rest] = path as [string | number, ...(string | number)[]]
  if (typeof head === 'number') {
    const list = Array.isArray(target) ? [...(target as unknown[])] : []
    list[head] = setIn(list[head], rest, value)
    return list
  }
  const obj = { ...asRecord(target) }
  const next = setIn(getOwn(obj, head), rest, value)
  if (next === undefined) delete obj[head]
  else obj[head] = next
  return obj
}

export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list]
  if (from < 0 || from >= next.length || to < 0 || to >= next.length) return next
  next.splice(to, 0, ...next.splice(from, 1))
  return next
}

export function removeAt<T>(list: readonly T[], index: number): T[] {
  return list.filter((_, i) => i !== index)
}

/** 新加一项的初始值：带上 schema 里声明的默认值，免得界面上显示的是默认值、存进去却是空 */
export function initialValue(s: JsonSchema | undefined): unknown {
  if (!s) return undefined
  if (s.default !== undefined) return structuredClone(s.default)
  if (!isObjectSchema(s) || !s.properties) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(s.properties)) {
    const v = initialValue(child)
    if (v !== undefined) out[key] = v
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * 新加一行 / 一项的起始值：有默认值用默认值，否则给这种类型的空值。
 * 数字、下拉、JSON 没有说得通的空值，留 undefined 让人去填。
 */
export function blankValue(s: JsonSchema): unknown {
  const init = initialValue(s)
  if (init !== undefined) return init
  switch (fieldKind(s)) {
    case 'string':
    case 'textarea':
    case 'secret':
      return ''
    case 'boolean':
      return false
    case 'object':
    case 'map':
      return {}
    case 'multi':
    case 'string[]':
    case 'object[]':
      return []
    default:
      return undefined
  }
}

// ---- 映射（键值对）----

export interface MapRow {
  key: string
  value: unknown
  /** 这一行刚加进来时的值：键还空着、值也没动过的行当作没写完，直接忽略 */
  seed?: unknown
}

/**
 * 编辑中的各行 → 要保存的对象。有问题（键为空但值动过、键重复、值没填）时 problems 非空，
 * 调用方不该把 value 传出去——重复的键里总有一个会被悄悄吞掉。
 */
export function mapFromRows(rows: readonly MapRow[]): { value: Record<string, unknown>; problems: Array<{ row: number; key: string; message: string }> } {
  const problems: Array<{ row: number; key: string; message: string }> = []
  const count = new Map<string, number>()
  for (const r of rows) count.set(r.key.trim(), (count.get(r.key.trim()) ?? 0) + 1)
  const entries: Array<[string, unknown]> = []
  rows.forEach((r, row) => {
    const key = r.key.trim()
    if (!key) {
      if (JSON.stringify(r.value) !== JSON.stringify(r.seed)) problems.push({ row, key, message: '键不能为空' })
    } else if ((count.get(key) ?? 0) > 1) problems.push({ row, key, message: `键「${key}」重复了` })
    else if (r.value === undefined) problems.push({ row, key, message: '还没填值' })
    else entries.push([key, r.value])
  })
  // fromEntries 按自有属性写入：键叫 __proto__ 也不会改掉原型
  return { value: Object.fromEntries(entries), problems }
}

// ---- 密钥（writeOnly）----

/**
 * 运行时把 writeOnly 的值换成这个前缀加字段路径再发给面板，保存时原样传回，它再换回真值。
 * 与 packages/runtime/src/configSecrets.ts 里的同名常量是同一个约定，两边必须一致。
 */
export const SECRET_PLACEHOLDER_PREFIX = '__qflare_secret__:'

export function isSecretPlaceholder(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SECRET_PLACEHOLDER_PREFIX)
}

// ---- JSON 文本框 ----

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
