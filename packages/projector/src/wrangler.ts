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

  const envKvId = process.env.CF_KV_ID?.trim()
  const envD1Id = process.env.CF_D1_ID?.trim()
  const envR2Name = process.env.CF_R2_NAME?.trim()

  if (!kv) warnings.push('wrangler 配置缺少 kv_namespaces，binding 名使用 KV')
  if (!d1) warnings.push('wrangler 配置缺少 d1_databases，binding 名使用 DB')
  if (kv && !kv.id && !envKvId) warnings.push(`kv_namespaces[0].id 缺失，使用占位符 ${PROVISIONED_PLACEHOLDER}`)
  if (d1 && !d1.database_id && !envD1Id) warnings.push(`d1_databases[0].database_id 缺失，使用占位符 ${PROVISIONED_PLACEHOLDER}`)
  if (r2 && !r2.bucket_name && !envR2Name) warnings.push(`r2_buckets[0].bucket_name 缺失，使用占位符 ${PROVISIONED_PLACEHOLDER}`)

  const vars: Record<string, string> = {}
  for (const [k, v] of Object.entries(config.vars ?? {})) {
    vars[k] = typeof v === 'string' ? v : JSON.stringify(v)
  }
  const envWorkerName = process.env.CF_WORKER_NAME?.trim()
  if (envWorkerName) vars.WORKER_NAME = envWorkerName

  const bindings: BaseBindings = {
    kv: { binding: kv?.binding ?? 'KV', namespaceId: kv?.id || envKvId || PROVISIONED_PLACEHOLDER },
    d1: { binding: d1?.binding ?? 'DB', databaseId: d1?.database_id || envD1Id || PROVISIONED_PLACEHOLDER },
  }
  if (r2) bindings.r2 = { binding: r2.binding, bucketName: r2.bucket_name || envR2Name || PROVISIONED_PLACEHOLDER }
  if (Object.keys(vars).length) bindings.vars = vars
  return { bindings, warnings }
}

/**
 * 基于原 wrangler 配置生成可直接 `wrangler deploy` 的配置：
 * 指向投影输出、关闭打包、追加插件 DO 绑定与 sqlite 迁移，并按需注入动态推导的资源绑定 ID。
 */
export function generateWranglerConfig(opts: {
  base: WranglerConfig
  projection: Projection
  /** 相对 wrangler 文件所在目录的 index.js 路径 */
  mainPath: string
  bindings?: BaseBindings
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

  // 动态重写 Worker 脚本名与环境标识
  const workerName = process.env.CF_WORKER_NAME?.trim()
  if (workerName) {
    config.name = workerName
    if (config.vars) {
      config.vars = { ...config.vars, WORKER_NAME: workerName }
    }
  }

  // 动态补齐缺省的资源绑定 ID 与自定义域名；未指定的可选资源安全剥离避免校验失败
  const kvId = (opts.bindings?.kv?.namespaceId && opts.bindings.kv.namespaceId !== PROVISIONED_PLACEHOLDER)
    ? opts.bindings.kv.namespaceId
    : process.env.CF_KV_ID?.trim()
  if (kvId && config.kv_namespaces?.[0] && !config.kv_namespaces[0].id) {
    config.kv_namespaces = [{ ...config.kv_namespaces[0], id: kvId }]
  }

  const d1Id = (opts.bindings?.d1?.databaseId && opts.bindings.d1.databaseId !== PROVISIONED_PLACEHOLDER)
    ? opts.bindings.d1.databaseId
    : (process.env.CF_D1_ID?.trim() !== 'none' ? process.env.CF_D1_ID?.trim() : undefined)
  if (d1Id) {
    if (config.d1_databases?.[0]) {
      config.d1_databases = [{ ...config.d1_databases[0], database_id: d1Id }]
    }
  } else if (
    (opts.bindings && (!opts.bindings.d1 || opts.bindings.d1.databaseId === PROVISIONED_PLACEHOLDER)) ||
    process.env.CF_D1_ID === 'none' ||
    !config.d1_databases?.[0]?.database_id ||
    config.d1_databases?.[0]?.database_id === PROVISIONED_PLACEHOLDER
  ) {
    delete config.d1_databases
  }

  const r2Name = (opts.bindings?.r2?.bucketName && opts.bindings.r2.bucketName !== PROVISIONED_PLACEHOLDER)
    ? opts.bindings.r2.bucketName
    : (process.env.CF_R2_NAME?.trim() !== 'none' ? process.env.CF_R2_NAME?.trim() : undefined)
  if (r2Name) {
    if (config.r2_buckets?.[0]) {
      config.r2_buckets = [{ ...config.r2_buckets[0], bucket_name: r2Name }]
    }
  } else if (
    (opts.bindings && (!opts.bindings.r2 || opts.bindings.r2.bucketName === PROVISIONED_PLACEHOLDER)) ||
    process.env.CF_R2_NAME === 'none' ||
    !config.r2_buckets?.[0]?.bucket_name ||
    config.r2_buckets?.[0]?.bucket_name === PROVISIONED_PLACEHOLDER
  ) {
    delete config.r2_buckets
  }

  const customDomain = process.env.CF_CUSTOM_DOMAIN?.trim()
  if (customDomain) {
    config.routes = [{ pattern: customDomain, custom_domain: true }]
  }

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
