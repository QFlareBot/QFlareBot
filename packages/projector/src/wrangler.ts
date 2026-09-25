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
  /** 声明 DO 生命周期的另一种模型；与 `migrations` 互斥（Cloudflare 强制） */
  exports?: Record<string, { type?: string; storage?: string }>
  [key: string]: unknown
}

/** 资源 id 尚未创建时的占位符，摘要中会提醒 */
export const PROVISIONED_PLACEHOLDER = '<provisioned>'

/**
 * `CF_D1_ID=none` / `CF_R2_NAME=none` 是「显式跳过该可选资源」的哨兵，不是资源标识。
 * 必须在这里就拦掉：否则它会被当成一个非空值参与绑定构造，既污染上传版本的 metadata
 * （多出一个叫 `none` 的绑定），又让 generateWranglerConfig 里的剥离分支永远进不去。
 */
const SKIP_SENTINEL = 'none'

interface EnvValue {
  value: string | undefined
  /** 显式要求跳过（值为 none）——此时不该再报「缺 id」的提醒 */
  skipped: boolean
}

function envValue(name: string): EnvValue {
  const raw = process.env[name]?.trim()
  if (!raw) return { value: undefined, skipped: false }
  if (raw === SKIP_SENTINEL) return { value: undefined, skipped: true }
  return { value: raw, skipped: false }
}

/** 该环境变量是否被显式要求跳过 */
function isSkipped(name: string): boolean {
  return envValue(name).skipped
}

export interface DerivedBindings {
  bindings: BaseBindings
  /** 使用了占位符的字段说明 */
  warnings: string[]
}

/** 一个可选资源的解析结果 */
export type BindingResolution = 'resolved' | 'unresolved' | 'skipped'

/**
 * 每个资源到底是「解析好了」「没解析出来」还是「被显式跳过（`CF_*=none`）」。
 *
 * 部署前的护栏只能靠这份状态判断，不能去扫上传元数据里的占位符字符串：
 * `buildBindings` 对 D1/R2 的处理是「是占位符就不 push」，没解析出来的绑定在
 * metadata 里是**不出现**而不是留个 `<provisioned>`——扫字符串只拦得住 KV，
 * D1/R2 会被静默丢掉（版本上线后 `env.DB` 直接消失）。
 */
export function resolveState(bindings: BaseBindings): Record<'kv' | 'd1' | 'r2', BindingResolution> {
  const one = (value: string | undefined, envName: string): BindingResolution => {
    if (isSkipped(envName)) return 'skipped'
    return !value || value === PROVISIONED_PLACEHOLDER ? 'unresolved' : 'resolved'
  }
  return {
    kv: one(bindings.kv?.namespaceId, 'CF_KV_ID'),
    d1: one(bindings.d1?.databaseId, 'CF_D1_ID'),
    r2: bindings.r2 ? one(bindings.r2.bucketName, 'CF_R2_NAME') : 'skipped',
  }
}

export function deriveBindings(config: WranglerConfig): DerivedBindings {
  const warnings: string[] = []
  const kv = config.kv_namespaces?.[0]
  const d1 = config.d1_databases?.[0]
  const r2 = config.r2_buckets?.[0]

  const envKv = envValue('CF_KV_ID')
  const envD1 = envValue('CF_D1_ID')
  const envR2 = envValue('CF_R2_NAME')
  const envKvId = envKv.value
  const envD1Id = envD1.value
  const envR2Name = envR2.value

  if (!kv) warnings.push('wrangler 配置缺少 kv_namespaces，binding 名使用 KV')
  if (!d1) warnings.push('wrangler 配置缺少 d1_databases，binding 名使用 DB')
  if (kv && !kv.id && !envKvId) warnings.push(`kv_namespaces[0].id 缺失，使用占位符 ${PROVISIONED_PLACEHOLDER}`)
  if (d1 && !d1.database_id && !envD1Id && !envD1.skipped) {
    warnings.push(`d1_databases[0].database_id 缺失，使用占位符 ${PROVISIONED_PLACEHOLDER}`)
  }
  if (r2 && !r2.bucket_name && !envR2Name && !envR2.skipped) {
    warnings.push(`r2_buckets[0].bucket_name 缺失，使用占位符 ${PROVISIONED_PLACEHOLDER}`)
  }

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

/** 把类名拼成一个可读的候选 tag（`P_foo_Game` → `p-foo-game`），并保证不与已有 tag 重复 */
export function suggestMigrationTag(existing: ReadonlySet<string>, classes: readonly string[]): string {
  const slug = classes
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .replace(/-$/, '')
  const base = slug || 'do-migration'
  let tag = base
  for (let i = 2; existing.has(tag); i++) tag = `${base}-${i}`
  return tag
}

/**
 * 插件 DO 类的迁移声明校验。
 *
 * `migrations` 是**只追加的历史**：平台记着「上次应用过的 tag」，下次部署拿它在列表里定位，
 * 只应用其后的新增项。所以 tag 一旦应用过就必须永远留在列表里——它是历史，不是当前状态的快照。
 *
 * 以前这里按投影哈希现造一条 tag，等于每次构建都把历史推倒重来：哈希一变（装/卸/升级任意插件都算），
 * 平台手里的旧 tag 就从列表里消失，wrangler 只能走「找不到已应用 tag」的恢复路径——警告，然后把
 * 整份列表当 steps 全量重放，重新声明已经存在的类。而构建机没有任何持久状态可记，造不出正确的历史，
 * 所以改为**校验**：模板的 migrations 必须覆盖当前所有 DO 类，缺了就报错让人补。
 */
function checkDoMigrations(base: WranglerConfig, doNames: readonly string[]): void {
  // 模板自己用 exports 声明 DO 生命周期时 migrations 必须缺席（Cloudflare 规定两者互斥），无需校验
  if (base.exports && Object.keys(base.exports).length > 0) return

  const migrations = base.migrations ?? []
  const declared = new Set<string>()
  for (const m of migrations) {
    for (const c of m.new_sqlite_classes ?? []) declared.add(c)
    for (const c of m.new_classes ?? []) declared.add(c)
  }
  const missing = doNames.filter((n) => !declared.has(n))
  if (!missing.length) return

  const tag = suggestMigrationTag(new Set(migrations.map((m) => m.tag)), missing)
  throw new Error(
    `插件 Durable Object 类没有出现在 migrations 里：${missing.join('、')}\n` +
      'migrations 是只追加的历史（平台靠「上次应用过的 tag」算增量），构建机没有这个状态，不能替你造。\n' +
      '请在 wrangler.jsonc 的 migrations 末尾追加一项后重新构建（tag 不能与已有重复）：\n' +
      `  { "tag": "${tag}", "new_sqlite_classes": [${missing.map((c) => `"${c}"`).join(', ')}] }`,
  )
}

/**
 * 基于原 wrangler 配置生成可直接 `wrangler deploy` 的配置：
 * 指向投影输出、关闭打包、追加插件 DO 绑定，并按需注入动态推导的资源绑定 ID。
 *
 * 注意这里**不再合成** `migrations`（原因见 checkDoMigrations）：只校验模板是否覆盖了当前所有 DO 类。
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
  // 显式跳过（CF_*=none）优先级最高：它表达的是「这个资源不存在」，模板里硬编码的值不能把它顶掉
  const skipKv = isSkipped('CF_KV_ID')
  const skipD1 = isSkipped('CF_D1_ID')
  const skipR2 = isSkipped('CF_R2_NAME')

  const kvId = skipKv
    ? undefined
    : (opts.bindings?.kv?.namespaceId && opts.bindings.kv.namespaceId !== PROVISIONED_PLACEHOLDER)
      ? opts.bindings.kv.namespaceId
      : process.env.CF_KV_ID?.trim()
  if (kvId && config.kv_namespaces?.[0] && !config.kv_namespaces[0].id) {
    config.kv_namespaces = [{ ...config.kv_namespaces[0], id: kvId }]
  }

  const d1Id = skipD1
    ? undefined
    : (opts.bindings?.d1?.databaseId && opts.bindings.d1.databaseId !== PROVISIONED_PLACEHOLDER)
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

  const r2Name = skipR2
    ? undefined
    : (opts.bindings?.r2?.bucketName && opts.bindings.r2.bucketName !== PROVISIONED_PLACEHOLDER)
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

  // 引导出来的新 Worker 需要 workers.dev（MANIFEST_URL 走默认域名，零外部 DNS 依赖），
  // 但绑了自定义域名之后没有理由继续把面板与 /webhook 暴露在 workers.dev 上。
  // 版本预览地址由 preview_urls 单独控制，与这个开关无关。
  const workersDev = process.env.CF_WORKERS_DEV?.trim()
  if (workersDev) config.workers_dev = workersDev !== '0' && workersDev !== 'false'

  const baseDoBindings = (base.durable_objects?.bindings ?? []).filter((b) => !b.name.startsWith('P_'))
  const pluginDoBindings = doNames.map((name) => ({ name, class_name: name }))
  if (baseDoBindings.length || pluginDoBindings.length) {
    config.durable_objects = { ...base.durable_objects, bindings: [...baseDoBindings, ...pluginDoBindings] }
  } else {
    delete config.durable_objects
  }

  // migrations 只校验、不合成——构建机没有「上次应用到哪个 tag」的持久状态，造不出正确的历史
  if (doNames.length) checkDoMigrations(base, doNames)
  if (!(base.migrations ?? []).length) delete config.migrations

  return config
}
