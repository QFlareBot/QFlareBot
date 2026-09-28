import { computed } from 'vue'
import { STEPS, stepIndex, type StepMeta } from '../lib/steps.js'
import type { StepId } from '../types.js'
import { useWizard } from '../wizard.js'

export type NodeState = 'done' | 'running' | 'error' | 'skipped' | 'todo'

export interface StepStatus extends StepMeta {
  state: NodeState
  /** 步骤名下面的一行小字：做完的写结果，进行中的写状态 */
  note: string
  current: boolean
  /** 能不能点回去看 */
  reachable: boolean
}

/** 每一步现在是什么状态（步骤栏、手机顶栏共用） */
export function useStepStatus() {
  const w = useWizard()

  function state(id: StepId): NodeState {
    const p = w.progress.value
    const done = w.completion.value
    switch (id) {
      case 'token':
        return w.account.value ? 'done' : 'todo'
      case 'options':
        return p?.started ? 'done' : 'todo'
      case 'deploy':
        return !p?.started ? 'todo' : !p.done ? 'running' : p.ok ? 'done' : 'error'
      case 'connect':
        return w.connection.value?.connected ? 'done' : done ? 'skipped' : 'todo'
      case 'builds':
        return done?.buildsTokenWritten || done?.buildsTokenKept ? 'done' : done ? 'skipped' : 'todo'
      case 'done':
        return done ? 'done' : 'todo'
    }
  }

  function note(id: StepId, s: NodeState): string {
    if (s === 'skipped') return '已跳过'
    switch (id) {
      case 'token':
        return w.account.value ? (w.account.value.name ?? '已验证') : ''
      case 'options':
        return s === 'done' ? w.workerName.value : ''
      case 'deploy':
        return { running: '进行中', done: '已上线', error: '失败，可以重试', skipped: '', todo: '' }[s]
      case 'connect':
        if (s === 'done') return `分支 ${w.connection.value?.branch ?? ''}`
        return stepIndex(w.reached.value) >= stepIndex('connect') ? '等待连接' : ''
      case 'builds':
        return s !== 'done' ? '' : w.completion.value?.buildsTokenKept ? '沿用已有' : '已配置'
      case 'done':
        return ''
    }
  }

  const steps = computed<StepStatus[]>(() =>
    STEPS.map((meta) => {
      const s = state(meta.id)
      return {
        ...meta,
        state: s,
        note: note(meta.id, s),
        current: w.current.value === meta.id,
        reachable: !w.completion.value && stepIndex(meta.id) <= stepIndex(w.reached.value),
      }
    }),
  )

  return { steps }
}
