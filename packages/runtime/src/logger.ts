import type { Logger } from '@qqbot/sdk'

type Level = 'debug' | 'info' | 'warn' | 'error'

/** 结构化 JSON 行日志，交给 Workers Logs / Tail Worker 收集 */
export function createLogger(scope: string): Logger {
  const emit = (level: Level, message: string, data?: unknown) => {
    const line = JSON.stringify({ level, scope, message, ...(data === undefined ? {} : { data }) })
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  }
  return {
    debug: (m, d) => emit('debug', m, d),
    info: (m, d) => emit('info', m, d),
    warn: (m, d) => emit('warn', m, d),
    error: (m, d) => emit('error', m, d),
  }
}

export function errorInfo(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) return { message: err.message, ...(err.stack ? { stack: err.stack } : {}) }
  return { message: String(err) }
}
