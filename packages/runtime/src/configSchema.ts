import type { JsonSchema } from '@qqbot/sdk'

/**
 * 一个字段一条错误。path 是字段的位置：顶层就是 configSchema.properties 里的键，
 * 嵌套的用点连起来（`llm.model`、`providers.0.api_key`），面板按它把错误放到对应的输入框下
 */
export interface ConfigFieldError {
  path: string
  message: string
}

type Json = Record<string, unknown>

export function isPlainObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 固定形状的对象（声明了 properties）：它的默认值要逐项合并；键名不固定的（additionalProperties）整个替换 */
function hasFixedShape(schema: unknown): boolean {
  return isPlainObject(schema) && isPlainObject(schema['properties'])
}

/**
 * 已保存的配置盖在默认配置上：插件升级后新增的配置项，保存过配置的用户也拿得到默认值。
 *
 * 顶层逐项合并；更深一层只对 schema 里声明了 properties 的对象继续合并——升级给嵌套对象加了字段，
 * 同样拿得到默认值。键名不固定的对象（additionalProperties）和数组整个替换：用户删掉的那一项不能被默认值加回来。
 * 两边不都是普通对象时原样返回已保存的（可能是 undefined，由调用方兜底）。
 */
export function withConfigDefaults(stored: unknown, defaults: unknown, schema?: JsonSchema): unknown {
  if (!isPlainObject(stored) || !isPlainObject(defaults)) return stored
  const properties = isPlainObject(schema?.['properties']) ? (schema['properties'] as Json) : {}
  const out: Json = { ...defaults }
  for (const [key, value] of Object.entries(stored)) {
    const sub = properties[key]
    out[key] = hasFixedShape(sub) ? withConfigDefaults(value, defaults[key], sub as JsonSchema) : value
  }
  return out
}

const TYPE_NAMES: Record<string, string> = {
  string: '字符串',
  number: '数字',
  boolean: '布尔值',
  object: '对象',
}

function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return '数组'
  return TYPE_NAMES[typeof value] ?? typeof value
}

/** `oneOf` 每一项都是 `{ const, title? }`：带标签的选项，与 enum 同样只认这几个值 */
function constOptions(schema: Json): unknown[] | null {
  const options = schema['oneOf'] ?? schema['anyOf']
  if (!Array.isArray(options) || options.length === 0) return null
  return options.every((o) => isPlainObject(o) && 'const' in o) ? options.map((o) => (o as Json)['const']) : null
}

const SCALAR_ITEM: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && !Number.isNaN(v),
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
}

/** 校验单个字段本身（不含里面的子字段）；只认面板能渲染的那几种，其余放行 */
function checkField(schema: Json, value: unknown): string | null {
  const enumValues = schema['enum']
  if (Array.isArray(enumValues)) {
    return enumValues.includes(value) ? null : `只能是 ${enumValues.map((v) => JSON.stringify(v)).join(' / ')} 之一`
  }
  const consts = constOptions(schema)
  if (consts) return consts.includes(value) ? null : `只能是 ${consts.map((v) => JSON.stringify(v)).join(' / ')} 之一`

  switch (schema['type']) {
    case 'string': {
      if (typeof value !== 'string') return `应为字符串，实际是${typeName(value)}`
      const min = schema['minLength']
      const max = schema['maxLength']
      if (typeof min === 'number' && value.length < min) return `至少 ${min} 个字符`
      if (typeof max === 'number' && value.length > max) return `最多 ${max} 个字符`
      return null
    }
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || Number.isNaN(value)) return `应为数字，实际是${typeName(value)}`
      if (schema['type'] === 'integer' && !Number.isInteger(value)) return '应为整数'
      const min = schema['minimum']
      const max = schema['maximum']
      if (typeof min === 'number' && value < min) return `不能小于 ${min}`
      if (typeof max === 'number' && value > max) return `不能大于 ${max}`
      return null
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : `应为布尔值，实际是${typeName(value)}`
    case 'array': {
      if (!Array.isArray(value)) return `应为数组，实际是${typeName(value)}`
      // 标量数组在面板上是一个输入组件，错误报在数组本身；对象数组逐项往下查（见 checkValue）
      const items = schema['items']
      const itemType = isPlainObject(items) ? items['type'] : undefined
      const valid = typeof itemType === 'string' ? SCALAR_ITEM[itemType] : undefined
      if (valid && !value.every(valid)) return `每一项都应为${TYPE_NAMES[itemType as string] ?? (itemType === 'integer' ? '整数' : itemType)}`
      return null
    }
    case 'object':
      return isPlainObject(value) ? null : `应为对象，实际是${typeName(value)}`
    // 未声明 type 的字段交给插件自己兜底，这里不拦
    default:
      return null
  }
}

function join(path: string, key: string | number): string {
  return path ? `${path}.${key}` : String(key)
}

/** 查一个字段，再往下查它的子字段：声明了 properties 的对象、additionalProperties、对象数组的每一项 */
function checkValue(schema: Json, value: unknown, path: string, errors: ConfigFieldError[]): void {
  const message = checkField(schema, value)
  if (message) {
    errors.push({ path, message })
    return
  }
  if (isPlainObject(value)) checkObject(schema, value, path, errors)
  const items = schema['items']
  if (Array.isArray(value) && isPlainObject(items) && items['type'] === 'object') {
    value.forEach((item, i) => checkValue(items, item, join(path, i), errors))
  }
}

/** 对象的子字段：required、properties 里声明了的逐个查；未声明的键放行（插件可能自己存额外状态），除非给了 additionalProperties 的 schema */
function checkObject(schema: Json, value: Json, path: string, errors: ConfigFieldError[]): void {
  const properties = isPlainObject(schema['properties']) ? schema['properties'] : {}
  const required = Array.isArray(schema['required']) ? schema['required'] : []
  for (const key of required) {
    if (typeof key === 'string' && value[key] === undefined) errors.push({ path: join(path, key), message: '必填' })
  }
  const extra = schema['additionalProperties']
  for (const [key, fieldValue] of Object.entries(value)) {
    // 缺失交给上面的 required 判断，这里只管有值的
    if (fieldValue === undefined) continue
    const sub = Object.hasOwn(properties, key) ? properties[key] : extra
    if (isPlainObject(sub)) checkValue(sub, fieldValue, join(path, key), errors)
  }
}

/**
 * 按 configSchema 校验面板提交的配置。
 *
 * 只覆盖面板能渲染的子集：string/number/integer/boolean/enum/oneOf 常量、标量数组、嵌套对象、
 * 键名不固定的对象（additionalProperties）、对象数组，以及各层的 required。
 * 未在 properties 里声明的键一律放行：插件可能自己存额外状态。
 */
export function validateConfig(schema: JsonSchema | undefined, value: unknown): ConfigFieldError[] {
  if (!schema || !isPlainObject(schema)) return []
  if (!isPlainObject(schema['properties'])) return []

  if (!isPlainObject(value)) {
    return [{ path: '', message: `配置应为对象，实际是${typeName(value)}` }]
  }

  const errors: ConfigFieldError[] = []
  checkObject(schema, value, '', errors)
  return errors
}
