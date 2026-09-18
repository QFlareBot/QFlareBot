/**
 * 把插件定义里的各种简写（直接给函数、以模式/事件名为键的对象）统一成带 handler 的数组，
 * 运行时与清单抽取都只面对这一种形状。
 */
import type { EventName } from './events.js'
import type {
  ButtonHandler,
  ButtonRule,
  ButtonSpec,
  Command,
  CommandHandler,
  CommandSpec,
  CronHandler,
  CronSpec,
  EventHandler,
  EventRule,
  MatchOptions,
  PluginDefinition,
  RegexHandler,
  RegexRule,
  RegexSpec,
} from './plugin.js'

export interface NormalizedCommand<C = unknown> extends CommandSpec {
  name: string
  handler: CommandHandler<C>
}
export interface NormalizedRegex<C = unknown> extends RegexSpec {
  handler: RegexHandler<C>
}
export interface NormalizedEvent<C = unknown> extends Pick<MatchOptions, 'priority' | 'block'> {
  event: EventName[]
  handler: EventHandler<C>
}
export interface NormalizedButton<C = unknown> extends ButtonSpec {
  id: string
  handler: ButtonHandler<C>
}
export interface NormalizedCron<C = unknown> extends CronSpec {
  handler: CronHandler<C>
}

export interface NormalizedPlugin<C = unknown> {
  commands: NormalizedCommand<C>[]
  regex: NormalizedRegex<C>[]
  events: NormalizedEvent<C>[]
  buttons: NormalizedButton<C>[]
  cron: NormalizedCron<C>[]
}

function isFn(v: unknown): v is (...args: never[]) => unknown {
  return typeof v === 'function'
}

/** `'^ping$/i'` 这种带 flags 的键拆成 pattern 与 flags */
function splitPattern(key: string): { pattern: string; flags?: string } {
  const m = /^\/(.*)\/([a-z]*)$/s.exec(key)
  if (!m) return { pattern: key }
  return m[2] ? { pattern: m[1]!, flags: m[2] } : { pattern: m[1]! }
}

export function normalizePlugin<C>(def: PluginDefinition<C>): NormalizedPlugin<C> {
  const commands: NormalizedCommand<C>[] = Object.entries(def.commands ?? {}).map(([name, cmd]) =>
    isFn(cmd) ? { name, handler: cmd as CommandHandler<C> } : { name, ...(cmd as Command<C> & object) },
  ) as NormalizedCommand<C>[]

  const regex: NormalizedRegex<C>[] = Array.isArray(def.regex)
    ? (def.regex as RegexRule<C>[])
    : Object.entries(def.regex ?? {}).map(([key, rule]) => {
        const base = splitPattern(key)
        return isFn(rule) ? { ...base, handler: rule as RegexHandler<C> } : { ...base, ...(rule as object) }
      }) as NormalizedRegex<C>[]

  const events: NormalizedEvent<C>[] = Array.isArray(def.events)
    ? (def.events as EventRule<C>[]).map(({ event, ...rest }) => ({ ...rest, event: Array.isArray(event) ? event : [event] }))
    : Object.entries(def.events ?? {}).map(([event, rule]) =>
        isFn(rule)
          ? { event: [event as EventName], handler: rule as EventHandler<C> }
          : { event: [event as EventName], ...(rule as object) },
      ) as NormalizedEvent<C>[]

  const buttons: NormalizedButton<C>[] = Object.entries(def.buttons ?? {}).map(([id, rule]) =>
    isFn(rule) ? { id, handler: rule as ButtonHandler<C> } : { id, ...(rule as ButtonRule<C> & object) },
  ) as NormalizedButton<C>[]

  const cron: NormalizedCron<C>[] = Array.isArray(def.cron)
    ? def.cron
    : Object.entries(def.cron ?? {}).map(([name, job]) => ({ name, ...job }))

  return { commands, regex, events, buttons, cron }
}
