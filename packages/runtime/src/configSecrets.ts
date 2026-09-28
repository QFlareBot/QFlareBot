/**
 * writeOnly 字段（API 密钥这类）的面板往返：下发时换成占位符，保存时换回真值。
 *
 * 面板从来不拿到真值：它渲染成「已设置 / 更换 / 清除」，用户没改就原样把占位符交回来。
 * 占位符里带的是字段当时的位置，不是值——数组里换过顺序也认得出来（按下标对齐的写法会串位）。
 *
 * 占位符前缀与 packages/ui/src/lib/schemaForm.ts 的 SECRET_PLACEHOLDER_PREFIX 必须一致：
 * 面板构建成独立的静态资源，不共用代码，只能各写一份。
 */
import { isPlainObject } from './configSchema.js'

const SECRET_PLACEHOLDER_PREFIX = '__qflare_secret__:'

export function isSecretPlaceholder(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SECRET_PLACEHOLDER_PREFIX)
}

/** 路径按段编码再用 / 连：段里有点号、斜杠也不歧义 */
function placeholderFor(path: readonly string[]): string {
  return SECRET_PLACEHOLDER_PREFIX + path.map(encodeURIComponent).join('/')
}

function pathOf(placeholder: string): string[] | null {
  const raw = placeholder.slice(SECRET_PLACEHOLDER_PREFIX.length)
  try {
    return raw ? raw.split('/').map(decodeURIComponent) : []
  } catch {
    return null
  }
}

function valueAt(root: unknown, path: readonly string[]): unknown {
  let current = root
  for (const key of path) {
    if (Array.isArray(current)) current = current[Number(key)]
    else if (isPlainObject(current)) current = Object.hasOwn(current, key) ? current[key] : undefined
    else return undefined
  }
  return current
}

type Leaf = (value: unknown, path: readonly string[]) => unknown

/**
 * 顺着 schema 找到每个 writeOnly 字段，交给 leaf 换值，其余原样返回（不改入参）。
 * 与面板、校验认同一套结构：properties、additionalProperties、数组的 items。
 */
function mapWriteOnly(schema: unknown, value: unknown, leaf: Leaf, path: readonly string[] = []): unknown {
  if (!isPlainObject(schema)) return value
  if (schema['writeOnly'] === true) return leaf(value, path)

  const items = schema['items']
  if (Array.isArray(value) && isPlainObject(items)) {
    return value.map((item, i) => mapWriteOnly(items, item, leaf, [...path, String(i)]))
  }
  if (isPlainObject(value)) {
    const properties = isPlainObject(schema['properties']) ? schema['properties'] : {}
    const extra = schema['additionalProperties']
    const out: Record<string, unknown> = {}
    for (const [key, field] of Object.entries(value)) {
      const sub = Object.hasOwn(properties, key) ? properties[key] : extra
      out[key] = mapWriteOnly(sub, field, leaf, [...path, key])
    }
    return out
  }
  return value
}

/** 下发给面板前：设置过的 writeOnly 值换成占位符；没设（空串、没有）的原样，面板据此显示「未设置」 */
export function maskSecrets(schema: unknown, config: unknown): unknown {
  return mapWriteOnly(schema, config, (value, path) => (typeof value === 'string' && value !== '' ? placeholderFor(path) : value))
}

/**
 * 面板交回来之后：占位符按它记的位置从 current（下发时那份配置）里取回真值，其余是用户新填的或清空的，原样保留。
 * 占位符对不上值（这期间别处改过配置）就置空——宁可让用户重填，也不能把占位符字符串当密钥存进去。
 * 不在 writeOnly 位置上的占位符不换：否则往普通字段里填一个占位符，就能把密钥「读」成明文。
 */
export function restoreSecrets(schema: unknown, incoming: unknown, current: unknown): unknown {
  return mapWriteOnly(schema, incoming, (value) => {
    if (!isSecretPlaceholder(value)) return value
    const path = pathOf(value)
    const real = path ? valueAt(current, path) : undefined
    return typeof real === 'string' ? real : ''
  })
}
