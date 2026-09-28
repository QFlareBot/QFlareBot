import type { Connection } from '../types.js'
import { formatClock } from './clock.js'

export type RowState = 'ok' | 'run' | 'warn' | 'fail'

const BUILD_STATUS: Record<string, string> = { queued: '排队中', initializing: '准备中', running: '构建中', stopped: '已结束' }

/**
 * 连上仓库后补跑的那次构建，怎么跟用户说。title / detail 给连接页，short 给步骤栏的小标签。
 * 没连上或者构建配置没写成（那就没补跑）时返回 null。
 */
export function buildSummary(c: Connection | null, now: number): { state: RowState; title: string; detail: string; short: string } | null {
  if (!c?.connected || !c.configured) return null
  if (c.unchanged) {
    return { state: 'ok', title: '上次的构建是成功的，这次不用补跑', detail: '配置没有改动，自部署链路照旧可用。', short: '无需补跑' }
  }
  if (c.buildOutcome === 'success') {
    return { state: 'ok', title: '补跑的构建成功了', detail: '自部署链路是通的。', short: '构建成功' }
  }
  if (c.buildOutcome) {
    return {
      state: 'fail',
      title: `补跑的构建没有成功（${c.buildOutcome}）`,
      detail: '打开构建记录看是哪一步失败，贴出来就能查。',
      short: '构建失败',
    }
  }
  if (c.buildStarted) {
    const label = (c.buildStatus && BUILD_STATUS[c.buildStatus]) || '已提交'
    const elapsed = c.buildStartedAt ? formatClock(now - c.buildStartedAt) : null
    return {
      state: 'run',
      title: `正在补跑一次构建：${label}`,
      detail: `${elapsed ? `已用 ${elapsed}。` : ''}要几分钟，可以先做下一步。`,
      short: elapsed ? `${label} · ${elapsed}` : label,
    }
  }
  return {
    state: 'warn',
    title: '补跑构建没触发成功',
    detail: `${c.buildError ?? '未知原因'}——不影响后续：到面板装一个插件时会再触发。`,
    short: '构建没触发',
  }
}
