import { ApiError } from '../api.js'

export interface Poller {
  start(): void
  stop(): void
}

/**
 * 串行轮询：上一次回来了才排下一次，不会叠请求。tick 返回 false 就停。
 * 后台标签页照样轮询——连接检测靠它触发，用户这时正在 Cloudflare 的页面里点 Connect。
 * 连续 maxFailures 次连不上（runner 结束、隧道断开）调 onOffline；其余报错下一轮再试。
 */
export function createPoller(
  tick: () => Promise<boolean>,
  { interval, maxFailures = 4, onOffline }: { interval: number | (() => number); maxFailures?: number; onOffline: () => void },
): Poller {
  let timer: ReturnType<typeof setTimeout> | null = null
  let active = false
  let failures = 0

  async function run() {
    timer = null
    if (!active) return
    let again = true
    try {
      again = await tick()
      failures = 0
    } catch (err) {
      if (err instanceof ApiError && err.offline && ++failures >= maxFailures) {
        active = false
        onOffline()
        return
      }
    }
    if (!active) return
    if (!again) {
      active = false
      return
    }
    timer = setTimeout(run, typeof interval === 'function' ? interval() : interval)
  }

  return {
    start() {
      if (active) return
      active = true
      void run()
    },
    stop() {
      active = false
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}
