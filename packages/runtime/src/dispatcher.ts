import {
  deliverReply,
  isMessageEvent,
  normalizePlugin,
  type InteractionCode,
  type Logger,
  type NormalizedPlugin,
  type PermissionTier,
  type PluginDefinition,
  type SendResult,
  type Session,
} from '@qqbot/sdk'
import type { ContextFactory } from './context.js'
import { errorInfo } from './logger.js'
import type { PluginRegistry, RegisteredPlugin } from './registry.js'
import type { Snapshot } from './types.js'

export interface DispatchDeps {
  registry: PluginRegistry
  snapshot: Snapshot
  contexts: ContextFactory
  commandPrefixes: string[]
  logger: Logger
  /** 插件加载后、执行前的钩子（生命周期 onInstall/onBoot） */
  prepare?: (plugin: RegisteredPlugin, def: PluginDefinition<unknown>) => Promise<void>
}

export interface MatchRecord {
  plugin: string
  kind: 'command' | 'regex' | 'event' | 'button'
  name: string
}

export interface DispatchReport {
  matched: MatchRecord[]
  errors: Array<{ plugin: string; stage: string; message: string }>
}

interface Candidate extends MatchRecord {
  priority: number
  block: boolean
  registered: RegisteredPlugin
  run(ctx: Parameters<NonNullable<PluginDefinition['middleware']>>[0]['ctx']): Promise<void>
}

/** 收集候选期间的错误出口：一个插件坏掉不能连带废掉整次分发 */
interface CollectHooks {
  /** 收集候选时就抛错（畸形定义、非法正则）——只废掉这个插件 */
  onError(plugin: string, stage: string, err: unknown): void
  /** 回复投递失败（限频、内容审核、令牌失效）——必须留痕，否则用户侧静默无响应 */
  onSendFailure(plugin: string, stage: string, result: SendResult): void
}

const regexCache = new Map<string, RegExp>()
// 同一个定义对象只归一化一次
const normalized = new WeakMap<PluginDefinition<unknown>, NormalizedPlugin<unknown>>()

export function normalizedOf(def: PluginDefinition<unknown>): NormalizedPlugin<unknown> {
  let n = normalized.get(def)
  if (!n) {
    n = normalizePlugin(def)
    normalized.set(def, n)
  }
  return n
}

/**
 * `g` 会让 `String.prototype.match` 只返回整段匹配、丢掉捕获组（插件普遍写 `match[1]`），
 * 而 `g` / `y` 都会把 `RegExp.lastIndex` 留在实例上，让 `.test()` 在多次调用间结果漂移。
 * 插件的正则只用来「判断命中并取捕获组」，所以这两个有状态标志在这里统一剥掉。
 */
function compileRegex(pattern: string, flags = ''): RegExp {
  const safeFlags = flags.replace(/[gy]/g, '')
  const key = `${safeFlags}/${pattern}`
  let re = regexCache.get(key)
  if (!re) {
    re = new RegExp(pattern, safeFlags)
    regexCache.set(key, re)
  }
  return re
}

export interface ParsedCommand {
  word: string
  args: string[]
  argText: string
  /** 来自无前缀解析时为 true：只有声明了 `bare: true` 的命令参与匹配 */
  bare: boolean
}

/** 解析命令：返回命中的前缀之后的命令词与参数 */
export function parseCommand(content: string, prefixes: string[]): ParsedCommand | null {
  for (const prefix of [...prefixes].sort((a, b) => b.length - a.length)) {
    if (!content.startsWith(prefix)) continue
    const rest = content.slice(prefix.length).trim()
    if (!rest) continue
    const [word = '', ...args] = rest.split(/\s+/)
    return { word, args, argText: rest.slice(word.length).trim(), bare: false }
  }
  return null
}

/** 无前缀解析：首词即命令词。仅当消息不以前缀开头时兜底，配合命令的 bare 声明使用 */
export function parseBareCommand(content: string): ParsedCommand | null {
  const rest = content.trim()
  if (!rest) return null
  const [word = '', ...args] = rest.split(/\s+/)
  if (!word) return null
  return { word, args, argText: rest.slice(word.length).trim(), bare: true }
}

function toInteractionCode(code: number): InteractionCode {
  return code >= 0 && code <= 5 && Number.isInteger(code) ? (code as InteractionCode) : 1
}

export function isEnabled(snapshot: Snapshot, name: string): boolean {
  return snapshot.plugins[name]?.enabled ?? true
}

function priorityOf(snapshot: Snapshot, name: string, declared: number | undefined): number {
  return snapshot.plugins[name]?.priority ?? declared ?? 0
}

function sceneAllowed(scenes: string[] | undefined, session: Session): boolean {
  return !scenes || scenes.includes(session.scene)
}

/** 权限不足但其余条件（命令词/正则/场景）都命中的匹配器，供统一回复兜底判断 */
interface DeniedMatch {
  plugin: string
  kind: 'command' | 'regex'
  name: string
}

/** 门槛层级：1 超级管理员（Bot 管理员名单）＞ 2 群主/群管理员（入站 member_role）＞ 3 普通成员 */
function tierOf(permission: PermissionTier | undefined): 1 | 2 | 3 {
  return permission === 'bot_admin' ? 1 : permission === 'group_admin' ? 2 : 3
}

/** deliverReply 的入参类型（SDK 未导出 HandlerResult，从函数签名取） */
type ReplyPayload = Parameters<typeof deliverReply>[1]

/** 收集候选时的共享上下文；抽出来是为了让单个插件的失败能被单独兜住 */
interface CollectContext {
  session: Session
  deps: DispatchDeps
  userTier: 1 | 2 | 3
  command: ParsedCommand | null
  candidates: Candidate[]
  denied: DeniedMatch[]
  send(plugin: string, stage: string, payload: ReplyPayload): Promise<void>
}

function collectCandidates(
  session: Session,
  plugins: Array<{ registered: RegisteredPlugin; def: PluginDefinition<unknown> }>,
  deps: DispatchDeps,
  hooks: CollectHooks,
): { candidates: Candidate[]; denied: DeniedMatch[] } {
  const candidates: Candidate[] = []
  const denied: DeniedMatch[] = []
  const prefixes = deps.snapshot.commandPrefixes ?? deps.commandPrefixes
  const command = isMessageEvent(session.event)
    ? parseCommand(session.content, prefixes) ?? parseBareCommand(session.content)
    : null

  /** 投递回复并检查结果：SendResult 被丢掉时只剩 rt_events 里一个失败计数，定位不到是谁、为什么 */
  const send = async (plugin: string, stage: string, payload: ReplyPayload): Promise<void> => {
    for (const result of await deliverReply(session, payload)) {
      if (!result.ok) hooks.onSendFailure(plugin, stage, result)
    }
  }

  // 单聊没有群角色，层级塌缩成两档：Bot 管理员 / 普通成员
  const userTier = deps.snapshot.admins?.includes(session.userId)
    ? 1
    : session.memberRole === 'owner' || session.memberRole === 'admin'
      ? 2
      : 3

  const shared: CollectContext = { session, deps, userTier, command, candidates, denied, send }
  for (const { registered, def } of plugins) {
    try {
      collectForPlugin(shared, registered, def)
    } catch (err) {
      // 单个插件定义畸形（非法正则、缺字段）只废掉它自己——不能让本次事件所有插件都不执行
      hooks.onError(def.name, 'match', err)
    }
  }

  // 稳定排序：优先级高的先执行，同级按注册顺序
  return { candidates: candidates.sort((a, b) => b.priority - a.priority), denied }
}

/** 收集单个插件的候选；独立成函数，调用方才能按插件兜异常 */
function collectForPlugin(
  shared: CollectContext,
  registered: RegisteredPlugin,
  def: PluginDefinition<unknown>,
): void {
  const { session, deps, userTier, command, candidates, denied, send } = shared
  const name = def.name
  const n = normalizedOf(def)

  if (command) {
    for (const cmd of n.commands) {
      // 无前缀消息只允许 bare 命令接住；带前缀的消息对 bare 命令同样生效
      if (command.bare && !cmd.bare) continue
      const names = [cmd.name, ...(cmd.aliases ?? [])]
      if (!names.some((c) => c.toLowerCase() === command.word.toLowerCase())) continue
      if (!sceneAllowed(cmd.scenes, session)) continue
      if (userTier > tierOf(cmd.permission)) {
        denied.push({ plugin: name, kind: 'command', name: cmd.name })
        continue
      }
      candidates.push({
        plugin: name,
        kind: 'command',
        name: cmd.name,
        priority: priorityOf(deps.snapshot, name, cmd.priority),
        block: cmd.block ?? true,
        registered,
        run: async (ctx) =>
          send(
            name,
            `command:${cmd.name}`,
            await cmd.handler({ session, ctx, command: command.word, args: command.args, argText: command.argText }),
          ),
      })
    }
  }

  if (isMessageEvent(session.event)) {
    for (const rule of n.regex) {
      if (!sceneAllowed(rule.scenes, session)) continue
      const match = session.content.match(compileRegex(rule.pattern, rule.flags))
      if (!match) continue
      if (userTier > tierOf(rule.permission)) {
        denied.push({ plugin: name, kind: 'regex', name: rule.pattern })
        continue
      }
      candidates.push({
        plugin: name,
        kind: 'regex',
        name: rule.pattern,
        priority: priorityOf(deps.snapshot, name, rule.priority),
        block: rule.block ?? false,
        registered,
        run: async (ctx) => send(name, `regex:${rule.pattern}`, await rule.handler({ session, ctx, match })),
      })
    }
  }

  const interaction = session.interaction
  if (interaction && (interaction.type === 'button' || interaction.type === 'menu')) {
    for (const rule of n.buttons) {
      if (rule.id !== interaction.buttonId) continue
      if (rule.dataPattern && !compileRegex(rule.dataPattern).test(interaction.buttonData)) continue
      if (!sceneAllowed(rule.scenes, session)) continue
      candidates.push({
        plugin: name,
        kind: 'button',
        name: rule.id,
        priority: priorityOf(deps.snapshot, name, rule.priority),
        block: rule.block ?? true,
        registered,
        run: async (ctx) => {
          const result = await rule.handler({
            session,
            ctx,
            interaction,
            buttonId: interaction.buttonId,
            buttonData: interaction.buttonData,
          })
          // 返回数字即回应平台的 code；返回消息则回复，ack 留给分发结束后的自动回应
          if (typeof result === 'number') await interaction.ack(toInteractionCode(result))
          else await send(name, `button:${rule.id}`, result)
        },
      })
    }
  }

  for (const rule of n.events) {
    if (!rule.event.includes(session.event)) continue
    candidates.push({
      plugin: name,
      kind: 'event',
      name: rule.event.join(','),
      priority: priorityOf(deps.snapshot, name, rule.priority),
      block: rule.block ?? false,
      registered,
      run: async (ctx) => send(name, `event:${rule.event.join(',')}`, await rule.handler({ session, ctx })),
    })
  }
}

/** 事件分发：中间件链 → 匹配器；任何插件的异常只记录、不影响其他插件 */
export async function dispatch(session: Session, deps: DispatchDeps): Promise<DispatchReport> {
  const report: DispatchReport = { matched: [], errors: [] }
  if (deps.snapshot.safeMode) {
    await session.interaction?.ack(0).catch(() => false)
    return report
  }

  const enabled = deps.registry.all().filter((p) => isEnabled(deps.snapshot, p.manifest.name))
  const loaded = await Promise.all(enabled.map(async (registered) => ({ registered, def: await registered.load() })))
  const plugins = loaded.filter((p): p is { registered: RegisteredPlugin; def: PluginDefinition<unknown> } => !!p.def)

  const fail = (plugin: string, stage: string, err: unknown) => {
    const info = errorInfo(err)
    report.errors.push({ plugin, stage, message: info.message })
    deps.logger.error('插件执行出错', { plugin, stage, ...info })
  }

  /**
   * 平台拒收（限频、内容审核、令牌失效）。
   *
   * 出站调用本身是有计数的：scope.ts 的 counting sender 会把失败累加进 rt_events.failed，
   * 所以「这次事件有一条没发出去」在库里查得到。缺的是**归属与原因**——不知道是哪个插件、
   * 哪条规则，也不知道平台回了什么状态码，wrangler tail 上更是一行都没有。这里补上。
   */
  const failSend = (plugin: string, stage: string, result: SendResult) => {
    const message = `回复投递失败：HTTP ${result.status}${result.error ? `（${result.error}）` : ''}`
    report.errors.push({ plugin, stage: `send:${stage}`, message })
    deps.logger.error('回复投递失败', { plugin, stage, status: result.status, error: result.error })
  }

  if (deps.prepare) {
    await Promise.all(plugins.map((p) => deps.prepare!(p.registered, p.def).catch((e) => fail(p.def.name, 'prepare', e))))
  }

  const runMatchers = async () => {
    const { candidates, denied } = collectCandidates(session, plugins, deps, {
      onError: fail,
      onSendFailure: failSend,
    })
    if (denied.length) deps.logger.debug('权限不足，跳过候选', { denied })
    for (const c of candidates) {
      report.matched.push({ plugin: c.plugin, kind: c.kind, name: c.name })
      try {
        const ctx = await deps.contexts.prepare(c.registered)
        await c.run(ctx)
      } catch (err) {
        fail(c.plugin, `${c.kind}:${c.name}`, err)
      }
      if (c.block) break
    }
    // 权限不足默认静默跳过；配置了统一回复时，仅当没有任何候选命中才补一句，避免遮蔽其他插件
    if (denied.length && !report.matched.length && deps.snapshot.permissionDeniedReply) {
      try {
        for (const result of await deliverReply(session, deps.snapshot.permissionDeniedReply)) {
          if (!result.ok) failSend('runtime', 'permission-denied', result)
        }
      } catch (err) {
        fail('runtime', 'permission-denied', err)
      }
    }
  }

  const middlewares = plugins
    .filter((p) => typeof p.def.middleware === 'function')
    .sort((a, b) => priorityOf(deps.snapshot, b.def.name, 0) - priorityOf(deps.snapshot, a.def.name, 0))

  const run = async (i: number): Promise<void> => {
    const mw = middlewares[i]
    if (!mw) return runMatchers()
    let nextCalled = false
    const next = () => {
      nextCalled = true
      return run(i + 1)
    }
    try {
      const ctx = await deps.contexts.prepare(mw.registered)
      await mw.def.middleware!({ session, ctx }, next)
    } catch (err) {
      fail(mw.def.name, 'middleware', err)
      // 中间件自身出错不应吞掉事件
      if (!nextCalled) await run(i + 1)
    }
  }

  try {
    await run(0)
  } catch (err) {
    // 中间件链或候选收集本身出错：事件不能静默消失，按钮更不能一直转圈——记下来，继续走下面的 ack
    fail('runtime', 'dispatch', err)
  }

  // 按钮/菜单必须回应平台，否则客户端一直转圈；插件没处理就替它回应成功
  const interaction = session.interaction
  if (interaction && (interaction.type === 'button' || interaction.type === 'menu') && !interaction.acked) {
    await interaction.ack(0).catch((err) => fail('runtime', 'ack', err))
  }
  return report
}
