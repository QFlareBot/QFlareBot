import type { Component } from 'vue'
import { Flag, GitBranch, KeyRound, Rocket, ShieldCheck, SlidersHorizontal } from 'lucide-vue-next'
import type { StepId } from '../types.js'

export interface StepMeta {
  id: StepId
  title: string
  icon: Component
}

/** 前五步是要做的事，「完成」是结果页 */
export const STEPS: StepMeta[] = [
  { id: 'token', title: '连接 Cloudflare', icon: KeyRound },
  { id: 'options', title: '基本设置', icon: SlidersHorizontal },
  { id: 'deploy', title: '部署', icon: Rocket },
  { id: 'connect', title: '连接仓库', icon: GitBranch },
  { id: 'builds', title: '构建 Token', icon: ShieldCheck },
  { id: 'done', title: '完成', icon: Flag },
]

export const TASK_COUNT = 5

export function stepIndex(id: StepId): number {
  return STEPS.findIndex((s) => s.id === id)
}

export function stepMeta(id: StepId): StepMeta {
  return STEPS[stepIndex(id)]!
}

/** 部署步骤里要跑好几分钟的那几项，给一句预期 */
export const SLOW_STEPS: Record<string, string> = {
  '构建并部署 Worker': '通常 2–4 分钟',
}
