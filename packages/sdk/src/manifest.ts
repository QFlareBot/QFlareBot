import type { EventName } from './events.js'
import {
  API_VERSION,
  type ButtonSpec,
  type CommandSpec,
  type CronSpec,
  type JsonSchema,
  type Permission,
  type PluginDefinition,
  type PluginUiSpec,
  type RegexSpec,
  type RouteSpec,
} from './plugin.js'

/**
 * 插件清单：PluginDefinition 中去掉全部函数后的纯数据。
 * 构建时生成为 manifest.json，面板、安装器、投影器只读它，不执行插件代码。
 */
export interface Manifest {
  name: string
  version: string
  apiVersion: number
  displayName?: string
  description?: string
  permissions: Permission[]
  configSchema?: JsonSchema
  defaultConfig?: unknown
  depends: Record<string, string>
  conflicts: string[]
  coreRange?: string

  commands: Array<CommandSpec & { name: string }>
  regex: RegexSpec[]
  events: Array<{ event: EventName[]; priority?: number; block?: boolean }>
  buttons: Array<ButtonSpec & { id: string }>
  cron: CronSpec[]
  routes: RouteSpec[]
  ui?: PluginUiSpec
  hasMiddleware: boolean
  services: string[]
  durableObjects: string[]
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}$/

/** 去掉值为 undefined 的键，保证 JSON 序列化后的清单稳定 */
function compact<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T
}

/** 从插件定义提取清单；`pkg` 用于补齐 version */
export function extractManifest(
  def: PluginDefinition<unknown>,
  pkg?: { version?: string },
): Manifest {
  const version = def.version ?? pkg?.version
  if (!version) throw new Error(`插件 ${def.name} 缺少 version`)

  const manifest: Manifest = {
    name: def.name,
    version,
    apiVersion: def.apiVersion ?? API_VERSION,
    permissions: def.permissions ?? [],
    depends: def.depends ?? {},
    conflicts: def.conflicts ?? [],

    commands: Object.entries(def.commands ?? {}).map(([name, { handler: _h, ...spec }]) =>
      compact({ name, ...spec }),
    ),
    regex: (def.regex ?? []).map(({ handler: _h, ...spec }) => compact(spec)),
    events: (def.events ?? []).map(({ handler: _h, event, ...spec }) =>
      compact({ event: Array.isArray(event) ? event : [event], ...spec }),
    ),
    buttons: Object.entries(def.buttons ?? {}).map(([id, { handler: _h, ...spec }]) => compact({ id, ...spec })),
    cron: (def.cron ?? []).map(({ handler: _h, ...spec }) => spec),
    routes: (def.routes ?? []).map(({ handler: _h, ...spec }) => spec),
    hasMiddleware: typeof def.middleware === 'function',
    services: Object.keys(def.services ?? {}),
    durableObjects: Object.keys(def.durableObjects ?? {}),
  }

  if (def.displayName !== undefined) manifest.displayName = def.displayName
  if (def.description !== undefined) manifest.description = def.description
  if (def.configSchema !== undefined) manifest.configSchema = def.configSchema
  if (def.defaultConfig !== undefined) manifest.defaultConfig = def.defaultConfig
  if (def.coreRange !== undefined) manifest.coreRange = def.coreRange
  if (def.ui !== undefined) manifest.ui = def.ui
  return manifest
}

/** 校验清单基本合法性，返回错误列表（空数组即合法） */
export function validateManifest(m: Manifest): string[] {
  const errors: string[] = []
  if (!NAME_PATTERN.test(m.name)) errors.push(`name 非法：${m.name}（小写字母、数字、- 或 _）`)
  if (!/^\d+\.\d+\.\d+/.test(m.version)) errors.push(`version 不是合法 semver：${m.version}`)
  if (m.apiVersion !== API_VERSION) errors.push(`apiVersion ${m.apiVersion} 与当前契约 ${API_VERSION} 不一致`)

  const seen = new Set<string>()
  for (const cmd of m.commands) {
    for (const n of [cmd.name, ...(cmd.aliases ?? [])]) {
      if (seen.has(n)) errors.push(`命令名重复：${n}`)
      seen.add(n)
    }
  }
  for (const r of m.regex) {
    try {
      new RegExp(r.pattern, r.flags)
    } catch {
      errors.push(`正则非法：/${r.pattern}/${r.flags ?? ''}`)
    }
  }
  for (const b of m.buttons) {
    if (!b.dataPattern) continue
    try {
      new RegExp(b.dataPattern)
    } catch {
      errors.push(`按键 ${b.id} 的 dataPattern 非法：${b.dataPattern}`)
    }
  }
  for (const c of m.cron) {
    if (c.cron.trim().split(/\s+/).length !== 5) errors.push(`cron 表达式需 5 段：${c.cron}`)
  }
  for (const r of m.routes) {
    if (!r.path.startsWith('/')) errors.push(`路由路径需以 / 开头：${r.path}`)
    if (r.path.includes('*') && !r.path.endsWith('/*')) errors.push(`通配只能出现在末尾 /*：${r.path}`)
  }
  if (m.ui && !m.ui.path.startsWith('/')) errors.push(`ui.path 需以 / 开头：${m.ui.path}`)
  return errors
}
