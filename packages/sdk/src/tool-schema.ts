import type { JsonSchema } from './plugin.js'

const annotations = new Set([
  'title',
  'description',
  'default',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
])
const supported = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'anyOf',
  'oneOf',
  'allOf',
  'not',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
])
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const types = ['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']

/** v1 明确支持的 JSON Schema 子集；不认识的约束拒绝注册，不能静默放行。 */
export function toolSchemaError(schema: unknown, depth = 0): string | null {
  if (depth > 16 || !object(schema)) return 'Schema 必须是对象且嵌套不超过 16 层'
  for (const key of Object.keys(schema))
    if (!supported.has(key) && !annotations.has(key)) return `不支持的 Schema 关键字：${key}`
  if (Array.isArray(schema.type) && schema.type.length === 0) return 'Schema type 数组不能为空'
  if (
    schema.type !== undefined &&
    !(Array.isArray(schema.type) ? schema.type : [schema.type]).every(
      t => typeof t === 'string' && types.includes(t),
    )
  )
    return 'Schema type 非法'
  if (schema.properties !== undefined && !object(schema.properties)) return 'properties 必须是对象'
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) || !schema.required.every(k => typeof k === 'string'))
  )
    return 'required 必须是字符串数组'
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length))
    return 'enum 必须是非空数组'
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== 'string') return 'pattern 必须是字符串'
    try {
      new RegExp(schema.pattern, 'u')
    } catch {
      return 'pattern 不是有效正则'
    }
  }
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (
      schema[key] !== undefined &&
      (!Number.isInteger(schema[key]) || (schema[key] as number) < 0)
    )
      return `${key} 必须是非负整数`
  }
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']) {
    if (
      schema[key] !== undefined &&
      (typeof schema[key] !== 'number' ||
        !Number.isFinite(schema[key]) ||
        (key === 'multipleOf' && (schema[key] as number) <= 0))
    )
      return `${key} 不是有效数字`
  }
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== 'boolean')
    return 'uniqueItems 必须是布尔值'
  const nested: unknown[] = Object.values(object(schema.properties) ? schema.properties : {})
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean')
    nested.push(schema.additionalProperties)
  for (const key of ['items', 'not']) if (schema[key] !== undefined) nested.push(schema[key])
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (schema[key] === undefined) continue
    if (!Array.isArray(schema[key]) || !(schema[key] as unknown[]).length)
      return `${key} 必须是非空 Schema 数组`
    nested.push(...(schema[key] as unknown[]))
  }
  for (const child of nested) {
    const error = toolSchemaError(child, depth + 1)
    if (error) return error
  }
  return null
}

const equal = (a: unknown, b: unknown): boolean => stableJson(a) === stableJson(b)
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

/** 调用入口对 JSON 数据校验；返回第一处错误，不做类型转换或补默认值。 */
export function validateToolValue(
  schema: JsonSchema,
  value: unknown,
  path = '$',
  depth = 0,
): string | null {
  if (depth > 32) return `${path} 嵌套太深`
  const recurse = (s: unknown, v: unknown, p = path) =>
    validateToolValue(s as JsonSchema, v, p, depth + 1)
  const typeMatches = (t: unknown) => {
    switch (t) {
      case 'object':
        return object(value)
      case 'array':
        return Array.isArray(value)
      case 'null':
        return value === null
      case 'number':
        return typeof value === 'number' && Number.isFinite(value)
      case 'integer':
        return typeof value === 'number' && Number.isSafeInteger(value)
      default:
        return typeof value === t
    }
  }
  if (
    schema.type !== undefined &&
    !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(typeMatches)
  )
    return `${path} 类型不匹配`
  if (Array.isArray(schema.enum) && !schema.enum.some(v => equal(v, value)))
    return `${path} 不在 enum 中`
  if (Object.hasOwn(schema, 'const') && !equal(schema.const, value)) return `${path} 不符合 const`
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (!Array.isArray(schema[key])) continue
    const results = (schema[key] as unknown[]).map(s => recurse(s, value) === null)
    if (
      key === 'anyOf'
        ? !results.some(Boolean)
        : key === 'oneOf'
          ? results.filter(Boolean).length !== 1
          : !results.every(Boolean)
    )
      return `${path} 不符合 ${key}`
  }
  if (schema.not && recurse(schema.not, value) === null) return `${path} 不符合 not`
  if (object(value)) {
    const props = object(schema.properties) ? schema.properties : {}
    for (const key of (schema.required as string[] | undefined) ?? [])
      if (!Object.hasOwn(value, key)) return `${path}.${key} 必填`
    for (const [key, child] of Object.entries(value)) {
      const sub = Object.hasOwn(props, key) ? props[key] : schema.additionalProperties
      if (sub === false) return `${path}.${key} 不允许额外参数`
      if (object(sub)) {
        const error = recurse(sub, child, `${path}.${key}`)
        if (error) return error
      }
    }
  }
  if (Array.isArray(value)) {
    if (
      (typeof schema.minItems === 'number' && value.length < schema.minItems) ||
      (typeof schema.maxItems === 'number' && value.length > schema.maxItems)
    )
      return `${path} 数组长度超限`
    if (schema.uniqueItems && new Set(value.map(stableJson)).size !== value.length)
      return `${path} 数组元素重复`
    if (schema.items)
      for (let i = 0; i < value.length; i++) {
        const error = recurse(schema.items, value[i], `${path}[${i}]`)
        if (error) return error
      }
  }
  if (typeof value === 'string') {
    const length = [...value].length
    if (
      (typeof schema.minLength === 'number' && length < schema.minLength) ||
      (typeof schema.maxLength === 'number' && length > schema.maxLength)
    )
      return `${path} 字符串长度超限`
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value))
      return `${path} 不符合 pattern`
  }
  if (typeof value === 'number') {
    if (
      (typeof schema.minimum === 'number' && value < schema.minimum) ||
      (typeof schema.maximum === 'number' && value > schema.maximum) ||
      (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) ||
      (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum)
    )
      return `${path} 数值超限`
    if (
      typeof schema.multipleOf === 'number' &&
      Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-9
    )
      return `${path} 不符合 multipleOf`
  }
  return null
}
