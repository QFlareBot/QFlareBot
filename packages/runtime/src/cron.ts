// 5 段 cron（分 时 日 月 周）分钟级匹配，支持 *、a-b、*/n、a,b、a-b/n

function matchField(expr: string, value: number, min: number, max: number): boolean {
  return expr.split(',').some((part) => {
    const [range = '*', stepStr] = part.split('/')
    const step = stepStr ? Number(stepStr) : 1
    if (!Number.isInteger(step) || step < 1) return false

    let lo = min
    let hi = max
    if (range !== '*') {
      const [a, b] = range.split('-').map(Number)
      if (a === undefined || Number.isNaN(a)) return false
      lo = a
      hi = b === undefined || Number.isNaN(b) ? (stepStr ? max : a) : b
    }
    return value >= lo && value <= hi && (value - lo) % step === 0
  })
}

/** 按 UTC 判断 `date` 所在分钟是否命中表达式 */
export function cronMatches(expression: string, date: Date): boolean {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) return false
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string]
  return (
    matchField(minute, date.getUTCMinutes(), 0, 59) &&
    matchField(hour, date.getUTCHours(), 0, 23) &&
    matchField(dom, date.getUTCDate(), 1, 31) &&
    matchField(month, date.getUTCMonth() + 1, 1, 12) &&
    matchField(dow.replace(/7/g, '0'), date.getUTCDay(), 0, 6)
  )
}
