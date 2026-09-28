import { computed, ref } from 'vue'

/** 每秒走一次的「现在」：用时、倒计时共用一个定时器 */
const tick = ref(Date.now())
setInterval(() => (tick.value = Date.now()), 1000)

/** 服务端时钟减本地时钟；时间戳都是服务端给的，换算过来才不受本机时间偏差影响 */
const offset = ref(0)

export function syncServerClock(serverNow: number): void {
  offset.value = serverNow - Date.now()
}

/** 本机时钟的「现在」，每秒更新（页面自己计时用） */
export const localNow = computed(() => tick.value)

/** 按服务端时钟算的「现在」 */
export const serverNow = computed(() => tick.value + offset.value)

/** 用时：不到 10 秒带一位小数，不到一分钟只写秒，再长写成 分:秒 */
export function formatDuration(ms: number): string {
  const safe = Math.max(0, ms)
  if (safe < 10_000) return `${(safe / 1000).toFixed(1)}s`
  if (safe < 60_000) return `${Math.floor(safe / 1000)}s`
  return formatClock(safe)
}

/** 分:秒，倒计时和长步骤用 */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
