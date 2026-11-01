import { PLUGIN_DURABLE_BASE } from './durable.js'
import type { EventName } from './events.js'
import { normalizePlugin } from './normalize.js'
import { pluginToolMetadata } from './tools.js'
import type { PluginToolManifest } from './tools.js'
import { toolSchemaError } from './tool-schema.js'
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
  /** 旧清单缺省为空；函数留在插件定义，目录无需加载插件代码。 */
  tools?: PluginToolManifest[]
  durableObjects: string[]
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}$/

/** 去掉值为 undefined 的键，保证 JSON 序列化后的清单稳定 */
function compact<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T
}

/**
 * DO 类必须继承 `PluginDurableObject`。
 *
 * 平台直接 `new Room(state, env)` 构造 DO，不经过框架，所以只有基类能把裸 env 换掉。
 * 忘了继承的后果是静默的——类照样部署、照样跑，但里面的 KV / D1 / R2 全是未加前缀的，
 * 建的表框架不认识、卸载时清不掉。这种「忘了就出事、出事还看不见」的约定必须在构建期挡住，
 * 跟 D1 表名占位符一样，不能只写在文档里。
 */
function assertDurableObjectsScoped(def: PluginDefinition<unknown>): void {
  const bad = Object.entries(def.durableObjects ?? {})
    .filter(([, cls]) => typeof cls !== 'function' || (cls as unknown as Record<symbol, unknown>)[PLUGIN_DURABLE_BASE] !== true)
    .map(([name]) => name)
  if (bad.length === 0) return
  throw new Error(
    `插件 ${def.name} 的 Durable Object 类必须继承 PluginDurableObject：${bad.join('、')}\n` +
      "  import { PluginDurableObject } from '@qqbot/sdk'\n" +
      `  export class ${bad[0]} extends PluginDurableObject { … }\n` +
      '不继承的话类里拿到的是未加前缀的裸 env，建的数据框架清不掉（卸载后永远是孤儿）。',
  )
}

/** 从插件定义提取清单；`pkg` 用于补齐 version */
export function extractManifest(
  def: PluginDefinition<unknown>,
  pkg?: { version?: string },
): Manifest {
  const version = def.version ?? pkg?.version
  if (!version) throw new Error(`插件 ${def.name} 缺少 version`)
  assertDurableObjectsScoped(def)
  const n = normalizePlugin(def)

  const manifest: Manifest = {
    name: def.name,
    version,
    apiVersion: def.apiVersion ?? API_VERSION,
    permissions: def.permissions ?? [],
    depends: def.depends ?? {},
    conflicts: def.conflicts ?? [],

    commands: n.commands.map(({ handler: _h, ...spec }) => compact(spec)),
    regex: n.regex.map(({ handler: _h, ...spec }) => compact(spec)),
    events: n.events.map(({ handler: _h, ...spec }) => compact(spec)),
    buttons: n.buttons.map(({ handler: _h, ...spec }) => compact(spec)),
    cron: n.cron.map(({ handler: _h, ...spec }) => spec),
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
  if (def.tools && Object.keys(def.tools).length) {
    manifest.tools = Object.entries(def.tools).map(([name, tool]) => {
      const direct = typeof tool.handler === 'function'
      const bound = typeof tool.service === 'string' && typeof tool.method === 'string'
      if (
        direct === bound ||
        (direct && (tool.mapInput || tool.mapOutput || tool.service || tool.method))
      ) {
        throw new Error(`工具 ${name} 必须选择 handler 或 service/method 其中一种实现`)
      }
      if (
        bound &&
        (typeof tool.mapOutput !== 'function' ||
          (tool.mapInput !== undefined && typeof tool.mapInput !== 'function'))
      ) {
        throw new Error(`服务工具 ${name} 需要 mapOutput，mapInput 必须为函数`)
      }
      return pluginToolMetadata(name, tool)
    })
  }
  return manifest
}

/**
 * 命令名的比较键：不分大小写、中间几个空白算一个，与运行时的匹配规则一致。
 * `'Pixiv  Random'` 与 `'pixiv random'` 是同一条命令
 */
export function commandKey(name: string): string {
  return name.trim().toLowerCase().split(/\s+/).join(' ')
}

/** 校验清单基本合法性，返回错误列表（空数组即合法） */
export function validateManifest(m: Manifest): string[] {
  const errors: string[] = []
  if (!NAME_PATTERN.test(m.name)) errors.push(`name 非法：${m.name}（小写字母、数字、- 或 _）`)
  if (!/^\d+\.\d+\.\d+/.test(m.version)) errors.push(`version 不是合法 semver：${m.version}`)
  // 清单里写的是最低要求：不高于当前契约就能装（见 API_VERSION）
  if (!Number.isInteger(m.apiVersion) || m.apiVersion < 1) errors.push(`apiVersion 非法：${m.apiVersion}（应为正整数）`)
  else if (m.apiVersion > API_VERSION) errors.push(`插件要求契约版本 ${m.apiVersion}，当前框架只支持到 ${API_VERSION}：请先升级机器人`)

  const seen = new Set<string>()
  if (m.services.some(name => name.startsWith('core.')))
    errors.push('core.* 是框架保留服务名，插件不能提供')
  if (m.tools?.length && m.apiVersion < 5) errors.push('公开 tools 要求 apiVersion >= 5')
  const toolNames = new Set<string>()
  if (m.tools !== undefined && !Array.isArray(m.tools)) errors.push('tools 必须是数组')
  for (const tool of Array.isArray(m.tools) ? m.tools : []) {
    if (!tool || typeof tool !== 'object') {
      errors.push('tools 条目必须是对象')
      continue
    }
    if (typeof tool.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(tool.name))
      errors.push(`工具名非法：${tool.name}`)
    if (toolNames.has(tool.name)) errors.push(`工具名重复：${tool.name}`)
    toolNames.add(tool.name)
    if (tool.service !== undefined || tool.method !== undefined) {
      if (typeof tool.service !== 'string' || !m.services.includes(tool.service)) {
        errors.push(`工具 ${tool.name} 只能绑定本插件声明的服务`)
      }
      if (
        typeof tool.method !== 'string' ||
        !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(tool.method) ||
        ['constructor', '__proto__', 'prototype'].includes(tool.method)
      ) {
        errors.push(`工具 ${tool.name} 的 method 必须是公开方法名`)
      }
    }
    if (
      typeof tool.description !== 'string' ||
      !tool.description.trim() ||
      tool.description.length > 1000
    )
      errors.push(`工具 ${tool.name} 的描述需为 1–1000 字符`)
    if (!['member', 'group_admin', 'bot_admin'].includes(tool.permission))
      errors.push(`工具 ${tool.name} 缺少有效 permission`)
    if (!['none', 'workspace_write', 'external_write', 'dangerous'].includes(tool.sideEffect))
      errors.push(`工具 ${tool.name} 缺少有效 sideEffect`)
    if (
      tool.timeoutMs !== undefined &&
      (!Number.isInteger(tool.timeoutMs) || tool.timeoutMs < 1 || tool.timeoutMs > 30_000)
    )
      errors.push(`工具 ${tool.name} 的 timeoutMs 应在 1–30000 之间`)
    if (tool.version !== undefined && (!Number.isInteger(tool.version) || tool.version < 1))
      errors.push(`工具 ${tool.name} 的 version 应为正整数`)
    if (
      tool.scenes !== undefined &&
      (!Array.isArray(tool.scenes) ||
        !tool.scenes.every(scene =>
          ['group', 'c2c', 'guild', 'guild_dm', 'unknown'].includes(scene),
        ))
    )
      errors.push(`工具 ${tool.name} 的 scenes 非法`)
    if (tool.inputSchema?.type !== 'object')
      errors.push(`工具 ${tool.name} 的 inputSchema 必须声明 type: object`)
    for (const schema of [tool.inputSchema, tool.outputSchema].filter(s => s !== undefined)) {
      const error = toolSchemaError(schema)
      if (error) errors.push(`工具 ${tool.name}：${error}`)
    }
  }
  for (const cmd of m.commands) {
    for (const n of [cmd.name, ...(cmd.aliases ?? [])]) {
      const key = commandKey(n)
      if (!key) errors.push(`命令名不能为空（${cmd.name || '未命名命令'}）`)
      else if (seen.has(key)) errors.push(`命令名重复：${n}`)
      seen.add(key)
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
