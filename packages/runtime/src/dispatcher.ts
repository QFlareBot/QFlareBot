import { isMessageEvent, type Logger, type PluginDefinition, type Session } from '@qqbot/sdk'
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
  kind: 'command' | 'regex' | 'event'
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

const regexCache = new Map<string, RegExp>()

function compileRegex(pattern: string, flags = ''): RegExp {
  const key = `${flags}/${pattern}`
  let re = regexCache.get(key)
  if (!re) {
    re = new RegExp(pattern, flags)
    regexCache.set(key, re)
  }
  return re
}

/** 解析命令：返回命中的前缀之后的命令词与参数 */
export function parseCommand(
  content: string,
  prefixes: string[],
): { word: string; args: string[]; argText: string } | null {
  for (const prefix of [...prefixes].sort((a, b) => b.length - a.length)) {
    if (!content.startsWith(prefix)) continue
    const rest = content.slice(prefix.length).trim()
    if (!rest) continue
    const [word = '', ...args] = rest.split(/\s+/)
    return { word, args, argText: rest.slice(word.length).trim() }
  }
  return null
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

function collectCandidates(
  session: Session,
  plugins: Array<{ registered: RegisteredPlugin; def: PluginDefinition<unknown> }>,
  deps: DispatchDeps,
): Candidate[] {
  const candidates: Candidate[] = []
  const prefixes = deps.snapshot.commandPrefixes ?? deps.commandPrefixes
  const command = isMessageEvent(session.event) ? parseCommand(session.content, prefixes) : null

  for (const { registered, def } of plugins) {
    const name = def.name

    if (command) {
      for (const [cmdName, cmd] of Object.entries(def.commands ?? {})) {
        const names = [cmdName, ...(cmd.aliases ?? [])]
        if (!names.some((n) => n.toLowerCase() === command.word.toLowerCase())) continue
        if (!sceneAllowed(cmd.scenes, session)) continue
        candidates.push({
          plugin: name,
          kind: 'command',
          name: cmdName,
          priority: priorityOf(deps.snapshot, name, cmd.priority),
          block: cmd.block ?? true,
          registered,
          run: (ctx) =>
            Promise.resolve(
              cmd.handler({ session, ctx, command: command.word, args: command.args, argText: command.argText }),
            ),
        })
      }
    }

    if (isMessageEvent(session.event)) {
      for (const rule of def.regex ?? []) {
        if (!sceneAllowed(rule.scenes, session)) continue
        const match = session.content.match(compileRegex(rule.pattern, rule.flags))
        if (!match) continue
        candidates.push({
          plugin: name,
          kind: 'regex',
          name: rule.pattern,
          priority: priorityOf(deps.snapshot, name, rule.priority),
          block: rule.block ?? false,
          registered,
          run: (ctx) => Promise.resolve(rule.handler({ session, ctx, match })),
        })
      }
    }

    for (const rule of def.events ?? []) {
      const events = Array.isArray(rule.event) ? rule.event : [rule.event]
      if (!events.includes(session.event)) continue
      candidates.push({
        plugin: name,
        kind: 'event',
        name: events.join(','),
        priority: priorityOf(deps.snapshot, name, rule.priority),
        block: rule.block ?? false,
        registered,
        run: (ctx) => Promise.resolve(rule.handler({ session, ctx })),
      })
    }
  }

  // 稳定排序：优先级高的先执行，同级按注册顺序
  return candidates.sort((a, b) => b.priority - a.priority)
}

/** 事件分发：中间件链 → 匹配器；任何插件的异常只记录、不影响其他插件 */
export async function dispatch(session: Session, deps: DispatchDeps): Promise<DispatchReport> {
  const report: DispatchReport = { matched: [], errors: [] }
  if (deps.snapshot.safeMode) return report

  const enabled = deps.registry.all().filter((p) => isEnabled(deps.snapshot, p.manifest.name))
  const loaded = await Promise.all(enabled.map(async (registered) => ({ registered, def: await registered.load() })))
  const plugins = loaded.filter((p): p is { registered: RegisteredPlugin; def: PluginDefinition<unknown> } => !!p.def)

  const fail = (plugin: string, stage: string, err: unknown) => {
    const info = errorInfo(err)
    report.errors.push({ plugin, stage, message: info.message })
    deps.logger.error('插件执行出错', { plugin, stage, ...info })
  }

  if (deps.prepare) {
    await Promise.all(plugins.map((p) => deps.prepare!(p.registered, p.def).catch((e) => fail(p.def.name, 'prepare', e))))
  }

  const runMatchers = async () => {
    for (const c of collectCandidates(session, plugins, deps)) {
      report.matched.push({ plugin: c.plugin, kind: c.kind, name: c.name })
      try {
        const ctx = await deps.contexts.prepare(c.registered)
        await c.run(ctx)
      } catch (err) {
        fail(c.plugin, `${c.kind}:${c.name}`, err)
      }
      if (c.block) break
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

  await run(0)
  return report
}
