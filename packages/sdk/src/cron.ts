// 5 段 cron（分 时 日 月 周），按 UTC 做分钟级匹配，语义照标准的 Vixie cron：
//
// - 每段支持 *、a、a-b、*/n、a-b/n、a/n（从 a 到上限每 n 个），逗号并列；
// - 月和星期可以写英文缩写 JAN-DEC、SUN-SAT，不分大小写，区间里也能用（MON-FRI）；
// - 星期取 0-7，0 和 7 都是周日；
// - 日和星期**都**受限时任一命中就算（OR），有一段以 * 开头时两段都得命中（AND）——
//   `0 9 1 * MON` 是「每月 1 号，加上每个周一」，不是「恰逢周一的 1 号」。
//
// 放在 SDK 里是因为两边要用同一套：运行时按它调度，`qqbot-plugin build` 用 cronError 提前警告写错的表达式，
// 而构建工具不依赖运行时。时区固定 UTC，与平台的 Cron Trigger 一致。

interface Field {
  label: string
  min: number
  max: number
  /** 可写的英文缩写，下标 i 对应值 min + i */
  names?: readonly string[]
}

const MINUTE: Field = { label: '分', min: 0, max: 59 }
const HOUR: Field = { label: '时', min: 0, max: 23 }
const DAY: Field = { label: '日', min: 1, max: 31 }
const MONTH: Field = {
  label: '月',
  min: 1,
  max: 12,
  names: ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'],
}
// 上限是 7：7 也是周日（Vixie cron 的写法），`1-7`、`5-7` 这类区间要能写
const WEEKDAY: Field = { label: '星期', min: 0, max: 7, names: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] }

const FIELDS = [MINUTE, HOUR, DAY, MONTH, WEEKDAY] as const

interface ParsedCron {
  /** 每段允许的取值，下标即值 */
  minute: boolean[]
  hour: boolean[]
  day: boolean[]
  month: boolean[]
  weekday: boolean[]
  /** 日 / 星期那段以 * 开头。Vixie cron 只看首字符，带步进的 * 也算 */
  dayStar: boolean
  weekdayStar: boolean
}

type ParseResult = { ok: true; cron: ParsedCron } | { ok: false; error: string }

function parseValue(text: string, field: Field): number | null {
  if (/^\d+$/.test(text)) return Number(text)
  const i = field.names?.indexOf(text.toUpperCase()) ?? -1
  return i >= 0 ? field.min + i : null
}

/** 把一段里命中的值标进 allowed；不合法时返回原因 */
function parseField(expr: string, field: Field, allowed: boolean[]): string | null {
  const bounds = `${field.min}-${field.max}`
  for (const part of expr.split(',')) {
    if (!part) return '有空项（多了个逗号？）'
    const pieces = part.split('/')
    if (pieces.length > 2) return `「${part}」里的 / 多了`
    const [range = '', stepText] = pieces
    let step = 1
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) return `「${part}」的步进要是正整数`
      step = Number(stepText)
    }

    let lo = field.min
    let hi = field.max
    if (range !== '*') {
      const ends = range.split('-')
      if (ends.length > 2) return `「${part}」不是合法的区间`
      const values: number[] = []
      for (const end of ends) {
        const v = parseValue(end, field)
        if (v === null) {
          const hint = field.names ? `，只能写数字或 ${field.names[0]}-${field.names[field.names.length - 1]}` : ''
          return `「${end || part}」不是合法的值${hint}`
        }
        if (v < field.min || v > field.max) return `「${end}」超出范围 ${bounds}`
        values.push(v)
      }
      lo = values[0]!
      // 单个值带步进（`5/15`）是从它到上限；不带就是它自己
      hi = values[1] ?? (stepText !== undefined ? field.max : lo)
      // 不支持绕回（SAT-SUN）：以前这种区间就从来不会命中，报出来比静默不跑强
      if (lo > hi) return `区间「${range}」的起点比终点大`
    }
    for (let v = lo; v <= hi; v += step) allowed[v] = true
  }
  return null
}

function parseCron(expression: string): ParseResult {
  const trimmed = expression.trim()
  if (!trimmed) return { ok: false, error: '表达式是空的' }
  const parts = trimmed.split(/\s+/)
  if (parts.length !== 5) return { ok: false, error: `要 5 段（分 时 日 月 周），实际是 ${parts.length} 段` }

  const sets: boolean[][] = []
  for (const [i, field] of FIELDS.entries()) {
    const allowed: boolean[] = []
    const reason = parseField(parts[i]!, field, allowed)
    if (reason) return { ok: false, error: `第 ${i + 1} 段（${field.label}）${reason}` }
    sets.push(allowed)
  }
  const [minute = [], hour = [], day = [], month = [], weekday = []] = sets
  return {
    ok: true,
    cron: { minute, hour, day, month, weekday, dayStar: parts[2]!.startsWith('*'), weekdayStar: parts[4]!.startsWith('*') },
  }
}

/**
 * 表达式哪里不合法；合法返回 null。
 * 不合法的表达式 cronMatches 一律判不命中——也就是这个定时任务永远不会跑。
 */
export function cronError(expression: string): string | null {
  const parsed = parseCron(expression)
  return parsed.ok ? null : parsed.error
}

/** 按 UTC 判断 `date` 所在分钟是否命中表达式；表达式不合法时恒为 false（原因见 cronError） */
export function cronMatches(expression: string, date: Date): boolean {
  const parsed = parseCron(expression)
  if (!parsed.ok) return false
  const c = parsed.cron
  if (!c.minute[date.getUTCMinutes()] || !c.hour[date.getUTCHours()] || !c.month[date.getUTCMonth() + 1]) return false

  const weekday = date.getUTCDay()
  const dayHit = c.day[date.getUTCDate()] === true
  const weekdayHit = c.weekday[weekday] === true || (weekday === 0 && c.weekday[7] === true)
  // 标准 cron 的规则：两段都受限时是「或」，否则等于只看受限的那段
  return c.dayStar || c.weekdayStar ? dayHit && weekdayHit : dayHit || weekdayHit
}
