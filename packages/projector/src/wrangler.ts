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
  migrations?: WranglerMigration[]
  /** 声明 DO 生命周期的另一种模型；与 `migrations` 互斥（Cloudflare 强制） */
  exports?: Record<string, { type?: string; storage?: string }>
  [key: string]: unknown
}

/** wrangler 的一条 DO 迁移（只列本包会读的字段） */
export interface WranglerMigration {
  tag: string
  /** KV 存储后端的新类 */
  new_classes?: string[]
  /** SQLite 存储后端的新类 */
  new_sqlite_classes?: string[]
  renamed_classes?: Array<{ from: string; to: string }>
  /** 从别的脚本挪过来的类：`from` 是对方脚本里的类名，`to` 是本脚本里的 */
  transferred_classes?: Array<{ from: string; from_script?: string; to: string }>
  deleted_classes?: string[]
}

/** 资源 id 尚未创建时的占位符，摘要中会提醒 */
export const PROVISIONED_PLACEHOLDER = '<provisioned>'

/**
 * `CF_D1_ID=none` / `CF_R2_NAME=none` 是「显式跳过该可选资源」的哨兵，不是资源标识。
 * 必须在这里就拦掉：否则它会被当成一个非空值参与绑定构造，既污染上传版本的 metadata
 * （多出一个叫 `none` 的绑定），又让 generateWranglerConfig 里的剥离分支永远进不去。
 *
 * KV 不认这个哨兵：运行时无条件用 `env.KV`（快照、会话都在里面），它不是可选资源。
 * 以前 `CF_KV_ID=none` 也算「显式跳过」，结果是生成一个不带 id 的 KV 绑定，降级到 wrangler deploy 时
 * 它会自动预配一个全新的 KV——快照与插件配置当场失联。现在按「没解析出来」处理，由部署护栏拒绝。
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
  const resolved = (value: string | undefined): BindingResolution =>
    !value || value === PROVISIONED_PLACEHOLDER ? 'unresolved' : 'resolved'
  const optional = (value: string | undefined, envName: string): BindingResolution =>
    isSkipped(envName) ? 'skipped' : resolved(value)
  return {
    // KV 是运行时必需的资源，永远不会是 skipped（见 SKIP_SENTINEL）：CF_KV_ID=none 时照样看 id 解析没有
    kv: resolved(bindings.kv?.namespaceId),
    d1: optional(bindings.d1?.databaseId, 'CF_D1_ID'),
    r2: bindings.r2 ? optional(bindings.r2.bucketName, 'CF_R2_NAME') : 'skipped',
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
  if (envKv.skipped && !kv?.id) {
    warnings.push('CF_KV_ID=none 不受支持：KV 是运行时必需的资源、不能跳过，按「没解析出来」处理（部署会被拒绝）')
  } else if (kv && !kv.id && !envKvId) {
    warnings.push(`kv_namespaces[0].id 缺失，使用占位符 ${PROVISIONED_PLACEHOLDER}`)
  }
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
 * 按顺序重放 migrations，得到重放完之后还存在的类，以及其中 KV 存储后端（new_classes 建的）的那些。
 * 同一条迁移里按 新建 → 改名 → 挪入 → 删除 的顺序处理；改名沿用旧类的存储后端，挪入的类看不出后端，不算 KV。
 */
function replayMigrations(migrations: readonly WranglerMigration[]): { existing: Set<string>; kvBacked: Set<string> } {
  const existing = new Set<string>()
  const kvBacked = new Set<string>()
  for (const m of migrations) {
    for (const c of m.new_classes ?? []) {
      existing.add(c)
      kvBacked.add(c)
    }
    for (const c of m.new_sqlite_classes ?? []) {
      existing.add(c)
      kvBacked.delete(c)
    }
    for (const r of m.renamed_classes ?? []) {
      const wasKv = kvBacked.has(r.from)
      existing.delete(r.from)
      kvBacked.delete(r.from)
      existing.add(r.to)
      if (wasKv) kvBacked.add(r.to)
      else kvBacked.delete(r.to)
    }
    for (const t of m.transferred_classes ?? []) {
      existing.add(t.to)
      kvBacked.delete(t.to)
    }
    for (const c of m.deleted_classes ?? []) {
      existing.delete(c)
      kvBacked.delete(c)
    }
  }
  return { existing, kvBacked }
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
 *
 * 「覆盖」要按历史**重放**一遍才算得准：新建（new_classes / new_sqlite_classes）、改名进来（renamed_classes 的 to）、
 * 从别的脚本挪进来（transferred_classes 的 to）都算现存；删掉的（deleted_classes）与改名前的旧名（renamed_classes 的 from）
 * 要从现存里减掉。只认新建的话，改过名的类会被当成缺失（逼人再「新建」一次同名类，平台拒绝），删掉的类又会被当成还在。
 *
 * 另外给一条不失败的警告：版本元数据（Versions API 路径）把插件 DO 一律按 `storage: 'sqlite'` 声明，
 * 类若是在 `new_classes`（KV 存储后端）里建的，两条部署路径对存储后端的说法不一致，平台可能拒绝上传。
 */
function checkDoMigrations(base: WranglerConfig, doNames: readonly string[], warnings?: string[]): void {
  // 模板自己用 exports 声明 DO 生命周期时 migrations 必须缺席（Cloudflare 规定两者互斥），无需校验
  if (base.exports && Object.keys(base.exports).length > 0) return

  const migrations = base.migrations ?? []
  const { existing, kvBacked } = replayMigrations(migrations)
  const missing = doNames.filter((n) => !existing.has(n))

  const kvClasses = doNames.filter((n) => kvBacked.has(n))
  if (kvClasses.length > 0) {
    warnings?.push(
      `插件 Durable Object 类 ${kvClasses.join('、')} 在 migrations 里是 new_classes（KV 存储后端），` +
        '而版本元数据按 SQLite 声明（exports 的 storage: "sqlite"）——两条部署路径对存储后端的说法不一致，' +
        'Versions API 上传可能被拒。插件 DO 请用 new_sqlite_classes 建（已经建成 KV 后端的类不能原地改存储后端）',
    )
  }
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
  /** 缺省时按 base 与环境变量现推（与 CLI 传进来的是同一套规则） */
  bindings?: BaseBindings
  /** 不致命的提醒（如 DO 存储后端不一致）追加到这里，由调用方打印 */
  warnings?: string[]
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

  // 动态补齐缺省的资源绑定 ID；没解析出来或显式跳过的可选资源整个剥离，避免校验失败。
  // 解析状态只由 resolveState 推一次（部署护栏看的也是它），这里不再各自读环境变量——
  // 以前三个分支各读一遍 CF_*，有的 trim 有的不 trim，` none ` 在一处算跳过、在另一处不算。
  // 显式跳过（CF_*=none）优先级最高：它表达的是「这个资源不存在」，模板里硬编码的值不能把它顶掉
  const bindings = opts.bindings ?? deriveBindings(base).bindings
  const state = resolveState(bindings)

  // KV 只补模板里缺的 id；没解析出来时保持原样，交给部署护栏拒绝（KV 不能跳过，见 SKIP_SENTINEL）
  if (state.kv === 'resolved' && config.kv_namespaces?.[0] && !config.kv_namespaces[0].id) {
    config.kv_namespaces = [{ ...config.kv_namespaces[0], id: bindings.kv.namespaceId }]
  }

  if (state.d1 === 'resolved') {
    if (config.d1_databases?.[0]) {
      config.d1_databases = [{ ...config.d1_databases[0], database_id: bindings.d1.databaseId }]
    }
  } else {
    delete config.d1_databases
  }

  if (state.r2 === 'resolved' && bindings.r2) {
    if (config.r2_buckets?.[0]) {
      config.r2_buckets = [{ ...config.r2_buckets[0], bucket_name: bindings.r2.bucketName }]
    }
  } else {
    delete config.r2_buckets
  }

  // 自定义域名不在这里注入，交给用户在 Cloudflare 后台绑：wrangler deploy 只在配置声明了
  // routes 时才碰域名，而一旦声明就按它**整体替换**（replace_state）——注入一个，
  // 用户在后台另绑的全被摘掉。不声明，所有部署路径都不动线上的域名。

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
  if (doNames.length) checkDoMigrations(base, doNames, opts.warnings)
  if (!(base.migrations ?? []).length) delete config.migrations

  return config
}
