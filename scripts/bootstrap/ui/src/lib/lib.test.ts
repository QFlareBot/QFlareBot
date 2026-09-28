import { describe, expect, it } from 'vitest'
import type { Connection } from '../types.js'
import { buildSummary } from './build.js'
import { formatClock, formatDuration } from './clock.js'
import { resourcePlan } from './names.js'

describe('资源名预览与引导脚本同一套规则', () => {
  const base = { workerName: '', defaultWorkerName: 'qqbot', kvName: '', d1Name: '', r2Name: '' }

  it('留空用默认名，R2 默认是 <Worker名>-artifacts', () => {
    expect(resourcePlan(base).map((r) => r.name)).toEqual(['qqbot', 'qqbot', 'qqbot', 'qqbot-artifacts'])
    expect(resourcePlan({ ...base, workerName: ' bot ' }).map((r) => r.name)).toEqual(['bot', 'bot', 'bot', 'bot-artifacts'])
  })

  it('none 表示不启用；KV 必须有，填 none 也按 Worker 名', () => {
    const plan = resourcePlan({ ...base, kvName: 'none', d1Name: 'none', r2Name: 'none' })
    expect(plan.map((r) => r.name)).toEqual(['qqbot', 'qqbot', null, null])
  })
})

describe('用时', () => {
  it('短的带一位小数，一分钟以上写成 分:秒', () => {
    expect(formatDuration(430)).toBe('0.4s')
    expect(formatDuration(12_400)).toBe('12s')
    expect(formatDuration(125_000)).toBe('2:05')
    expect(formatDuration(-5)).toBe('0.0s')
    expect(formatClock(599_600)).toBe('10:00')
  })
})

describe('补跑构建的说法', () => {
  const connected: Connection = {
    connected: true,
    configured: true,
    branch: 'main',
    error: null,
    buildStarted: true,
    buildStartedAt: 1_000,
    buildStatus: 'running',
    buildOutcome: null,
    buildError: null,
    buildsUrl: null,
    now: 0,
  }

  it('重跑时配置没变、没补跑：直接说不用补跑', () => {
    expect(buildSummary({ ...connected, unchanged: true, buildStarted: false }, 0)).toMatchObject({ state: 'ok', short: '无需补跑' })
  })

  it('没连上或配置没写成时不补跑，不显示', () => {
    expect(buildSummary(null, 0)).toBeNull()
    expect(buildSummary({ ...connected, connected: false }, 0)).toBeNull()
    expect(buildSummary({ ...connected, configured: false }, 0)).toBeNull()
  })

  it('进行中带状态与用时；成功、失败、没触发各有一句', () => {
    expect(buildSummary(connected, 63_000)).toMatchObject({ state: 'run', short: '构建中 · 1:02' })
    expect(buildSummary({ ...connected, buildOutcome: 'success' }, 0)).toMatchObject({ state: 'ok' })
    expect(buildSummary({ ...connected, buildOutcome: 'failure' }, 0)).toMatchObject({ state: 'fail', title: expect.stringContaining('failure') })
    expect(buildSummary({ ...connected, buildStarted: false, buildError: '403' }, 0)).toMatchObject({ state: 'warn', detail: expect.stringContaining('403') })
  })
})
