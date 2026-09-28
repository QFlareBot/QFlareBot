/**
 * 安装前的检查：拉插件仓库里的声明清单（manifest.json）与 package.json，判断能不能装
 * （conflicts、D1 表前缀、depends 的服务、新增的 DO 类），以及要提醒、但不拦的 warnings。
 * 除了拉清单、读 D1 里已装的条目，其余都是纯函数；卸载提示与面板列表也用这里的「已知插件的清单」。
 */
import { doExportName, suggestMigrationTag } from '@qqbot/projector'
import { commandKey, validateManifest, type Manifest } from '@qqbot/sdk'
import { requireDb } from './adminDb.js'
import {
  listManifestPluginRecords,
  parseGitSource,
  rawManifestUrl,
  rawPluginFileUrl,
  sameGitRepo,
  type GitSource,
  type ManifestPluginEntry,
  type ManifestPluginRecord,
} from './manifestStore.js'
import { knownPluginNames } from './purge.js'
import type { PluginRegistry } from './registry.js'
import { optionalDepends, requiredDepends } from './services.js'
import { prefixesCollide, tablePrefix } from './sqlScope.js'
import type { RequestScope } from './scope.js'
import type { AdminDeps } from './admin.js'

/**
 * 拉声明清单的结果。失败分两种：400 是来源本身的问题（不存在、不是合法清单），
 * 502 是 GitHub 那边没答上来（网络错误、5xx）——后者与用户填的 source 无关，别让人去改一个本来没错的来源。
 */
type DeclaredManifest = { ok: true; manifest: Manifest } | { ok: false; error: string; status: 400 | 502 }

/** 声明清单：root 的 manifest.json 优先，dist/manifest.json 兜底（旧仓库布局） */
export async function fetchDeclaredManifest(git: GitSource, fetchImpl: typeof fetch): Promise<DeclaredManifest> {
  const urls = [rawManifestUrl(git), rawManifestUrl(git, true)]
  for (const url of urls) {
    let res: Response
    try {
      res = await fetchImpl(url, { redirect: 'follow' })
    } catch (err) {
      return { ok: false, status: 502, error: `拉取声明清单失败：${err instanceof Error ? err.message : String(err)}` }
    }
    if (res.status === 404) continue
    if (!res.ok) return { ok: false, status: res.status >= 500 ? 502 : 400, error: `拉取声明清单失败：HTTP ${res.status} ${url}` }
    let manifest: Manifest
    try {
      manifest = JSON.parse(await res.text()) as Manifest
    } catch {
      return { ok: false, status: 400, error: `声明清单不是合法 JSON：${url}` }
    }
    if (typeof manifest !== 'object' || manifest === null || typeof manifest.name !== 'string') {
      return { ok: false, status: 400, error: `声明清单缺少 name 字段：${url}` }
    }
    return { ok: true, manifest }
  }
  // 匿名读 raw.githubusercontent.com：私有仓库在这里也是 404，别让人以为只是没提交清单
  return {
    ok: false,
    status: 400,
    error:
      '拉不到插件的声明清单（manifest.json）：仓库不存在、是私有仓库（只支持公开的 GitHub 仓库），' +
      '或这个 commit 下没有 manifest.json——插件作者需要运行 qqbot-plugin build，并把生成的 manifest.json 提交到仓库根目录',
  }
}

// ---------- 已知插件的清单：安装校验、卸载提示、面板列表共用 ----------

/** 每个已知插件的清单：线上这份部署里的，再用 D1 存的声明清单覆盖（D1 是期望状态） */
export function knownManifests(records: readonly ManifestPluginRecord[], registry: PluginRegistry): Map<string, Manifest> {
  const map = new Map<string, Manifest>()
  for (const p of registry.all()) map.set(p.manifest.name, p.manifest)
  for (const r of records) if (r.manifest) map.set(r.name, r.manifest)
  return map
}

/** 除 name 之外的已知插件提供的服务 */
function providedElsewhere(name: string, manifests: ReadonlyMap<string, Manifest>): Set<string> {
  const services = new Set<string>()
  for (const [other, m] of manifests) if (other !== name) for (const s of m.services ?? []) services.add(s)
  return services
}

/**
 * 卸载 name 之后会断掉哪些插件：它们**必需**依赖的服务只有 name 提供（可选依赖没了照常跑）。
 * depends 的键是服务名（ctx.service 按服务名解析），不是插件名。
 */
export function dependentsOf(name: string, manifests: ReadonlyMap<string, Manifest>): string[] {
  const provided = manifests.get(name)?.services ?? []
  if (provided.length === 0) return []
  const elsewhere = providedElsewhere(name, manifests)
  const exclusive = new Set(provided.filter((s) => !elsewhere.has(s)))
  if (exclusive.size === 0) return []
  return [...manifests]
    .filter(([other, m]) => other !== name && requiredDepends(m).some((d) => exclusive.has(d)))
    .map(([other]) => other)
    .sort()
}

/** 这个插件此前已经有过的 DO 类：线上部署里的，加上 D1 里存的（装的时候确认过 migrations） */
export function knownDurableObjects(name: string, records: readonly ManifestPluginRecord[], registry: PluginRegistry): Set<string> {
  const known = new Set<string>(registry.get(name)?.manifest.durableObjects ?? [])
  for (const c of records.find((r) => r.name === name)?.manifest?.durableObjects ?? []) known.add(c)
  return known
}

/** 同一插件上一版的清单：D1 里存的优先，其次线上的 */
export function previousManifest(name: string, records: readonly ManifestPluginRecord[], registry: PluginRegistry): Manifest | null {
  return records.find((r) => r.name === name)?.manifest ?? registry.get(name)?.manifest ?? null
}

function commandKeys(m: Manifest): Set<string> {
  const keys = new Set<string>()
  for (const c of m.commands ?? []) for (const n of [c.name, ...(c.aliases ?? [])]) keys.add(commandKey(n))
  return keys
}

function repoLabel(git: GitSource): string {
  return `${git.owner}/${git.repo}${git.subdir ? `#${git.subdir}` : ''}`
}

export type Failure = { ok: false; error: string; status: number; code?: string }

/** 声明了 DO 类、但还没确认仓库 migrations 已就位——面板据此给出「我已加好」的确认入口 */
export const DO_MIGRATION_REQUIRED = 'durable_objects_migration_required'

/**
 * depends 的服务没有提供者。面板批量安装时靠它认出「提供者就在这一批里、按顺序装就行」：
 * 预检不写 D1，同一批里排在后面的使用者预检时还看不到提供者
 */
export const DEPENDENCIES_MISSING = 'dependencies_missing'

/**
 * 声明了 Durable Object 的插件，装进来之前必须先往仓库的 wrangler.jsonc 补一条 migrations。
 *
 * 为什么非拦不可：migrations 是只追加的历史，平台靠「上次应用过的 tag」算增量，构建机没有
 * 这个持久状态、造不出正确的历史，所以 projector 选择了校验而不是合成（见 checkDoMigrations）。
 * 校验发生在 prepare 阶段——也就是说插件已经写进 D1 之后才炸，而且是**每一次**构建都炸，
 * 包括之后装别的插件、一键更新、卸载以外的任何操作，直到有人想到把它卸载。
 *
 * 只拦**新增**的类：这个插件以前有过的类（线上部署里的，或者 D1 里存的、装的时候确认过的），
 * migrations 早就在仓库里了——升级时再拦一次，会让声明了 DO 的插件永远没法一键更新。
 *
 * 运行时读不到仓库里的 wrangler.jsonc（它不在 bundle 里），没法判断那条 migrations 是否
 * 已经加好，所以只能拦下来把要加的内容原样给出，由用户确认后带 acknowledgeDurableObjects 重装。
 */
function durableObjectsNotice(declared: Manifest, known: ReadonlySet<string>): string | null {
  const added = (declared.durableObjects ?? []).filter((c) => !known.has(c))
  if (added.length === 0) return null
  const exportNames = added.map((c) => doExportName(declared.name, c))
  const tag = suggestMigrationTag(new Set<string>(), exportNames)
  return (
    `${declared.name} ${known.size > 0 ? '的新版本新增了' : '声明了'} Durable Object 类（${added.join('、')}），装进来之前需要先改仓库。\n` +
    'DO 的 migrations 是只追加的历史，平台靠「上次应用过的 tag」算增量，构建机没有这个状态、造不出来。\n' +
    '请在 apps/seed/wrangler.jsonc 的 migrations 末尾追加一项并提交（tag 不能与已有重复）：\n' +
    `  { "tag": "${tag}", "new_sqlite_classes": [${exportNames.map((n) => `"${n}"`).join(', ')}] }\n` +
    '不加就装的话，之后每一次构建都会失败（包括装别的插件），直到把它卸载。\n' +
    '已经加好并推送了？确认后重新安装即可。'
  )
}

/** 拉到并校验过的声明清单，以及判断它能不能装要用到的上下文 */
interface Inspected {
  ok: true
  git: GitSource
  declared: Manifest
  entry: ManifestPluginEntry
  records: ManifestPluginRecord[]
  /** D1 里的同名条目（有即为升级） */
  existing: ManifestPluginRecord | undefined
  known: Map<string, Manifest>
  /** 已知插件名（knownPluginNames：线上、D1、账本、待收尾），查表前缀嵌套用 */
  knownNames: Set<string>
  /** 新增了 DO 类时要给用户看的 migrations 提示；null 表示不需要确认 */
  doNotice: string | null
}

/** 拉声明清单并做格式校验 */
export async function inspectSource(source: string, scope: RequestScope, deps: AdminDeps): Promise<Inspected | Failure> {
  const db = await requireDb(scope)
  if (!db) return { ok: false, error: '未绑定 D1，无法安装插件', status: 503 }

  const git = parseGitSource(source)
  if (!git) return { ok: false, error: `source 需为 git:<owner>/<repo>@<commit>[#<子目录>] 格式：${source}`, status: 400 }

  const fetched = await fetchDeclaredManifest(git, deps.options.fetchImpl)
  if (!fetched.ok) return { ok: false, error: fetched.error, status: fetched.status }
  const declared = fetched.manifest
  const problems = validateManifest(declared)
  if (problems.length > 0) return { ok: false, error: `声明清单非法：${problems.join('；')}`, status: 400 }

  const records = await listManifestPluginRecords(db)
  return {
    ok: true,
    git,
    declared,
    entry: { name: declared.name, version: declared.version, source },
    records,
    existing: records.find((p) => p.name === declared.name),
    known: knownManifests(records, deps.registry),
    knownNames: await knownPluginNames(scope.env, deps.registry),
    doNotice: durableObjectsNotice(declared, knownDurableObjects(declared.name, records, deps.registry)),
  }
}

/** 装不了的情况（与以前一样的几条硬规则）：conflicts、表前缀撞车、依赖缺失 */
export function blockingProblem(inspected: Inspected, deps: AdminDeps): Failure | null {
  const { declared, records, known } = inspected
  const allNames = new Set<string>([...records.map((p) => p.name), ...deps.registry.all().map((p) => p.manifest.name)])

  const conflict = (declared.conflicts ?? []).find((c) => allNames.has(c))
  if (conflict) return { ok: false, error: `安装 ${declared.name} 与已装插件冲突：${declared.name} conflicts ${conflict}`, status: 409 }

  // D1 表前缀不是单射：`my-plugin` 与 `my_plugin` 都落到 p_my_plugin_，卸载一个会连带删掉另一个的表。
  // 装进来就晚了（DROP 不可逆），所以在安装这一步就挡住。
  const prefixClash = [...allNames].find((n) => prefixesCollide(n, declared.name))
  if (prefixClash) {
    return {
      ok: false,
      status: 409,
      error:
        `${declared.name} 与已装插件 ${prefixClash} 的 D1 表前缀相同（${tablePrefix(declared.name)}）——` +
        '两者不能共存：卸载其中一个会连带删掉另一个的表，且不可逆。请把插件名里的 `-` 改成 `_`（或反过来）后重装。',
    }
  }

  // depends 的键是服务名（ctx.service 按服务名解析）。提供者既算线上这份部署里的，也算 D1 里已经装了、
  // 还在等构建的——否则先装提供者、紧接着装使用者会被误拒。键与某个插件同名也放行（以前就这么认）。
  // 可选依赖不拦：没有提供者也照常能装，缺什么在 installWarnings 里提一句
  const services = providedElsewhere(declared.name, known)
  const missingDeps = requiredDepends(declared).filter(
    (d) => !allNames.has(d) && !deps.registry.providerOf(d) && !services.has(d),
  )
  if (missingDeps.length > 0) {
    return {
      ok: false,
      status: 400,
      code: DEPENDENCIES_MISSING,
      error: `依赖未满足：${missingDeps.join('、')}（需先安装提供者，或由内置插件提供该服务）`,
    }
  }
  return null
}

/**
 * 要提醒、但不拦的事。以前这些情况都能直接装上，现在也照样能装——
 * 只是写进响应的 warnings，面板在预检时摆出来让人确认。
 */
export function installWarnings(inspected: Inspected, registry: PluginRegistry): string[] {
  const { declared, git, existing, known, records } = inspected
  const name = declared.name
  const warnings: string[] = []

  // 同名即覆盖：换了仓库就不是「升级」，是换成了另一家的代码
  const existingGit = existing ? parseGitSource(existing.source) : null
  const live = registry.get(name)
  if (existingGit) {
    if (!sameGitRepo(existingGit, git)) {
      warnings.push(`已装的 ${name} 来自 ${repoLabel(existingGit)}，这次会换成 ${repoLabel(git)} 的代码（同名即覆盖）`)
    }
  } else if (live && live.origin?.from !== 'd1') {
    warnings.push(`与仓库内置插件 ${name} 同名：装上后会替换内置的那一份，卸载之后内置的才会回来`)
  } else if (live?.origin) {
    // 卸载还没生效（线上还在、D1 里已经没了）又装回来
    const liveGit = parseGitSource(live.origin.source)
    if (liveGit && !sameGitRepo(liveGit, git)) {
      warnings.push(`线上的 ${name} 来自 ${repoLabel(liveGit)}，这次会换成 ${repoLabel(git)} 的代码（同名即覆盖）`)
    }
  }

  // permissions 只是知情同意，但升级新增的那几项得让人看见
  const previous = previousManifest(name, records, registry)
  if (previous) {
    const added = (declared.permissions ?? []).filter((p) => !(previous.permissions ?? []).includes(p))
    if (added.length > 0) warnings.push(`新版本新增权限：${added.join('、')}`)
  }

  // 命令撞名：运行时按优先级只有一个会响应，另一个被静默遮住
  const mine = commandKeys(declared)
  for (const [other, m] of known) {
    if (other === name) continue
    const clash = [...commandKeys(m)].filter((c) => mine.has(c))
    if (clash.length > 0) {
      warnings.push(`与 ${other} 的命令重名：${clash.map((c) => `/${c}`).join('、')}（运行时按优先级只有一个会响应）`)
    }
  }

  // conflicts 的另一个方向：新插件自己没声明，但已装的插件声明了与它冲突
  for (const [other, m] of known) {
    if (other !== name && (m.conflicts ?? []).includes(name)) warnings.push(`已装的 ${other} 声明与 ${name} 冲突`)
  }

  // 服务重名：能共存，但同一时间只有一个在提供。以前后装的被悄悄忽略，只在日志里提一句
  for (const service of declared.services ?? []) {
    const others = [...known].filter(([other, m]) => other !== name && (m.services ?? []).includes(service)).map(([other]) => other)
    if (others.length > 0) {
      warnings.push(`${others.join('、')} 也提供服务 ${service}：同一时间只有一个在提供，默认是先装的那个，可以在「插件」页切换`)
    }
  }

  // 可选依赖没人提供：照样能装，只是那部分功能用不了
  const provided = providedElsewhere(name, known)
  const absent = optionalDepends(declared).filter((d) => !known.has(d) && !provided.has(d) && !registry.providerOf(d))
  if (absent.length > 0) warnings.push(`可选依赖 ${absent.join('、')} 目前没有插件提供，相关功能暂时用不了，装上提供者后自动可用`)

  warnings.push(...tablePrefixWarnings(name, inspected.knownNames, new Set([...records.map((r) => r.name), ...registry.all().map((p) => p.manifest.name)])))
  return warnings
}

/**
 * D1 表前缀嵌套：`foo` 的前缀 `p_foo_` 是 `foo_bar` 的前缀 `p_foo_bar_` 的前缀，于是 `foo` 的 `{bar_x}`
 * 与 `foo_bar` 的 `{x}` 是同一张表。前缀完全相同的已装插件在 blockingProblem 里就拦了；嵌套的以前能装、
 * 现在也照样能装（插件名改不了，拦了就永远装不上），只提醒：两边的表可能撞名，卸载清数据时撞上的表
 * 会被跳过、留成孤儿。卸载过、数据可能还留着的名字（账本、待收尾里的）同样算——前缀相同时新装的会接手它的表。
 */
function tablePrefixWarnings(name: string, knownNames: ReadonlySet<string>, installed: ReadonlySet<string>): string[] {
  const mine = tablePrefix(name)
  const warnings: string[] = []
  for (const other of [...knownNames].sort()) {
    if (other === name) continue
    const theirs = tablePrefix(other)
    const label = installed.has(other) ? `已装的 ${other}` : `装过的 ${other}`
    if (mine === theirs) {
      // 已装的同前缀插件已经被拦下（409），走到这里的只会是装过、已卸载的
      if (!installed.has(other)) {
        warnings.push(`${name} 与${label} 的 D1 表前缀相同（${mine}）：${other} 留下的表会被 ${name} 当成自己的`)
      }
      continue
    }
    if (!mine.startsWith(theirs) && !theirs.startsWith(mine)) continue
    const [short, long] = mine.length < theirs.length ? [name, other] : [other, name]
    const rest = tablePrefix(long).slice(tablePrefix(short).length)
    warnings.push(
      `${name} 与${label} 的 D1 表前缀嵌套（${tablePrefix(short)} 是 ${tablePrefix(long)} 的前缀）：` +
        `${short} 的 {${rest}…} 表与 ${long} 的 {…} 表是同一张。两边建表可能撞名，卸载清数据时撞上的表会被跳过、留成孤儿`,
    )
  }
  return warnings
}

/** 插件的第三方依赖（package.json 的 dependencies），预检时给人看 */
interface DependencyInfo {
  /** 包名 → 版本范围；框架自己的包（@qqbot/*）不在里面 */
  packages: Record<string, string>
  /** 有第三方依赖时，仓库里有没有 lockfile；没有依赖就不查，为 null */
  lockfile: boolean | null
  /** 写进了 dependencies 的框架包 */
  framework: string[]
}

/**
 * 读插件的 package.json 看依赖，有依赖再探一下 lockfile 在不在。拉不到就当没有依赖——
 * 这里只是提前提醒，真正按 lockfile 装、装不上就失败的，是构建机（见 seed 的 plugin-build.mjs）。
 */
export async function inspectDependencies(git: GitSource, fetchImpl: typeof fetch): Promise<DependencyInfo> {
  const info: DependencyInfo = { packages: {}, lockfile: null, framework: [] }
  let deps: unknown
  try {
    const res = await fetchImpl(rawPluginFileUrl(git, 'package.json'), { redirect: 'follow' })
    if (!res.ok) return info
    deps = (JSON.parse(await res.text()) as { dependencies?: unknown }).dependencies
  } catch {
    return info
  }
  if (typeof deps !== 'object' || deps === null) return info
  for (const [name, range] of Object.entries(deps as Record<string, unknown>)) {
    if (typeof range !== 'string') continue
    if (name.startsWith('@qqbot/')) info.framework.push(name)
    else info.packages[name] = range
  }
  if (Object.keys(info.packages).length === 0) return info

  // 只探在不在：lockfile 动辄几百 KB，Worker 里没必要整份拉下来
  info.lockfile = false
  for (const file of ['package-lock.json', 'pnpm-lock.yaml', 'npm-shrinkwrap.json']) {
    try {
      const res = await fetchImpl(rawPluginFileUrl(git, file), { headers: { range: 'bytes=0-0' }, redirect: 'follow' })
      await res.body?.cancel()
      if (res.ok) {
        info.lockfile = true
        break
      }
    } catch {
      // 探不到当作没有
    }
  }
  return info
}

/** 依赖上注定会让构建失败的两种情况：与构建机的 planDependencyInstall 同一套规则 */
export function dependencyWarnings(info: DependencyInfo): string[] {
  const names = Object.keys(info.packages)
  if (names.length === 0) return []
  const warnings: string[] = []
  if (info.lockfile === false) {
    warnings.push(`插件依赖第三方包（${names.join('、')}），但仓库里没有 lockfile：构建会失败——请插件作者提交 package-lock.json 或 pnpm-lock.yaml`)
  }
  if (info.framework.length > 0) {
    warnings.push(`dependencies 里的 ${info.framework.join('、')} 要移到 devDependencies，否则构建会失败（框架包一律用机器人仓库那一份）`)
  }
  return warnings
}

/** 预检给面板看的清单摘要 */
export function summarizeManifest(m: Manifest) {
  return {
    name: m.name,
    version: m.version,
    ...(m.displayName !== undefined ? { displayName: m.displayName } : {}),
    ...(m.description !== undefined ? { description: m.description } : {}),
    permissions: m.permissions ?? [],
    services: m.services ?? [],
    depends: Object.keys(m.depends ?? {}),
    durableObjects: m.durableObjects ?? [],
    commands: (m.commands ?? []).map((c) => c.name),
  }
}
