import type { JsonSchema } from '@qqbot/sdk'

/** 一个字段一条错误；path 是 configSchema.properties 里的键 */
export interface ConfigFieldError {
  path: string
  message: string
}

type Json = Record<string, unknown>

function isPlainObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

/** 校验单个字段；只认 SchemaForm 能渲染的那几种，其余类型放行 */
function checkField(schema: Json, value: unknown): string | null {
  const enumValues = schema['enum']
  if (Array.isArray(enumValues)) {
    return enumValues.includes(value) ? null : `只能是 ${enumValues.map((v) => JSON.stringify(v)).join(' / ')} 之一`
  }

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
      const items = schema['items']
      if (isPlainObject(items) && items['type'] === 'string' && value.some((v) => typeof v !== 'string')) {
        return '每一项都应为字符串'
      }
      return null
    }
    // object 与未声明 type 的字段交给插件自己兜底，这里不拦
    default:
      return null
  }
}

/**
 * 按 configSchema 校验面板提交的配置。
 *
 * 只覆盖 SchemaForm 能渲染的子集（string/number/integer/boolean/string[]/enum + required），
 * 嵌套对象等复杂类型放行——面板对它们也是退化成 JSON 文本框，拦了反而挡住合法用法。
 * 未在 properties 里声明的键一律放行：插件可能自己存额外状态。
 */
export function validateConfig(schema: JsonSchema | undefined, value: unknown): ConfigFieldError[] {
  if (!schema || !isPlainObject(schema)) return []
  const properties = schema['properties']
  if (!isPlainObject(properties)) return []

  if (!isPlainObject(value)) {
    return [{ path: '', message: `配置应为对象，实际是${typeName(value)}` }]
  }

  const errors: ConfigFieldError[] = []
  const required = Array.isArray(schema['required']) ? schema['required'] : []
  for (const key of required) {
    if (typeof key === 'string' && value[key] === undefined) {
      errors.push({ path: key, message: '必填' })
    }
  }

  for (const [key, fieldSchema] of Object.entries(properties)) {
    const fieldValue = value[key]
    // 缺失交给上面的 required 判断，这里只管有值的
    if (fieldValue === undefined || !isPlainObject(fieldSchema)) continue
    const message = checkField(fieldSchema, fieldValue)
    if (message) errors.push({ path: key, message })
  }

  return errors
}
