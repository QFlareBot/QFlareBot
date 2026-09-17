import type { BaseBindings, Projection } from './types.js'

/** 只描述本包会读写的字段，其余原样透传 */
export interface WranglerConfig {
  name?: string
  main?: string
  compatibility_date?: string
  compatibility_flags?: string[]
  no_bundle?: boolean
  rules?: Array<{ type: string; globs: string[]; fallthrough?: boolean }>
  kv_namespaces?: Array<{ binding: string; id?: string; preview_id?: string }>
  d1_databases?: Array<{ binding: string; database_id?: string; database_name?: string }>
  r2_buckets?: Array<{ binding: string; bucket_name?: string }>
  vars?: Record<string, unknown>
  durable_objects?: { bindings?: Array<{ name: string; class_name: string; script_name?: string }> }
  migrations?: Array<{ tag: string; new_classes?: string[]; new_sqlite_classes?: string[] }>
  [key: string]: unknown
}

/** 资源 id 尚未创建时的占位符，摘要中会提醒 */
export const PROVISIONED_PLACEHOLDER = '<provisioned>'

export interface DerivedBindings {
  bindings: BaseBindings
  /** 使用了占位符的字段说明 */
  warnings: string[]
}

export function deriveBindings(config: WranglerConfig): DerivedBindings {
  const warnings: string[] = []
  const kv = config.kv_namespaces?.[0]
  const d1 = config.d1_databases?.[0]
  const r2 = config.r2_buckets?.[0]

  if (!kv) warnings.push('wrangler 配置缺少 kv_namespaces，binding 名使用 KV')
  if (!d1) warnings.push('wrangler 配置缺少 d1_databases，binding 名使用 DB')
  if (kv && !kv.id) warnings.push(`kv_namespaces[0].id 缺失，使用占位符 ${PROVISIONED_PLACEHOLDER}`)
  if (d1 && !d1.database_id) warnings.push(`d1_databases[0].database_id 缺失，使用占位符 ${PROVISIONED_PLACEHOLDER}`)
  if (r2 && !r2.bucket_name) warnings.push(`r2_buckets[0].bucket_name 缺失，使用占位符 ${PROVISIONED_PLACEHOLDER}`)

  const vars: Record<string, string> = {}
  for (const [k, v] of Object.entries(config.vars ?? {})) {
    vars[k] = typeof v === 'string' ? v : JSON.stringify(v)
  }

  const bindings: BaseBindings = {
    kv: { binding: kv?.binding ?? 'KV', namespaceId: kv?.id ?? PROVISIONED_PLACEHOLDER },
    d1: { binding: d1?.binding ?? 'DB', databaseId: d1?.database_id ?? PROVISIONED_PLACEHOLDER },
  }
  if (r2) bindings.r2 = { binding: r2.binding, bucketName: r2.bucket_name ?? PROVISIONED_PLACEHOLDER }
  if (Object.keys(vars).length) bindings.vars = vars
  return { bindings, warnings }
}

/**
 * 基于原 wrangler 配置生成可直接 `wrangler deploy` 的配置：
 * 指向投影输出、关闭打包、追加插件 DO 绑定与 sqlite 迁移。
 */
export function generateWranglerConfig(opts: {
  base: WranglerConfig
  projection: Projection
  /** 相对 wrangler 文件所在目录的 index.js 路径 */
  mainPath: string
}): WranglerConfig {
  const { base, projection } = opts
  const doNames = Object.keys(projection.metadata.exports ?? {})

  const config: WranglerConfig = {
    ...base,
    main: opts.mainPath,
    no_bundle: true,
    rules: [{ type: 'ESModule', globs: ['**/*.js'] }],
  }
  if (base.compatibility_date === undefined) config.compatibility_date = projection.metadata.compatibility_date

  const baseDoBindings = (base.durable_objects?.bindings ?? []).filter((b) => !b.name.startsWith('P_'))
  const pluginDoBindings = doNames.map((name) => ({ name, class_name: name }))
  if (baseDoBindings.length || pluginDoBindings.length) {
    config.durable_objects = { ...base.durable_objects, bindings: [...baseDoBindings, ...pluginDoBindings] }
  } else {
    delete config.durable_objects
  }

  const baseMigrations = (base.migrations ?? []).filter((m) => !m.tag.startsWith('p-'))
  const migrations = [...baseMigrations]
  if (doNames.length) {
    migrations.push({ tag: `p-${projection.hash.slice(0, 8)}`, new_sqlite_classes: doNames })
  }
  if (migrations.length) config.migrations = migrations
  else delete config.migrations

  return config
}
