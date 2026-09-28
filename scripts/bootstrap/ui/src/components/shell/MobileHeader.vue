<script setup lang="ts">
/** 手机顶栏：标志、当前第几步、主题与终止；下面一条分段进度 */
import BrandMark from '@panel/components/BrandMark.vue'
import { Power } from 'lucide-vue-next'
import { computed } from 'vue'
import { useLeave } from '../../composables/useLeave.js'
import { useStepStatus } from '../../composables/useStepStatus.js'
import { stepIndex, TASK_COUNT } from '../../lib/steps.js'
import { useWizard } from '../../wizard.js'
import ThemeToggle from '../base/ThemeToggle.vue'

const w = useWizard()
const { steps } = useStepStatus()
const { leave, busy, finished } = useLeave()
const tasks = computed(() => steps.value.slice(0, TASK_COUNT))
const label = computed(() => {
  const i = stepIndex(w.current.value)
  return i < TASK_COUNT ? `${i + 1}/${TASK_COUNT} · ${steps.value[i]!.title}` : '已完成'
})
const fill = (s: (typeof tasks.value)[number]) => (s.state === 'done' || s.state === 'skipped' ? 1 : s.current ? 0.45 : 0)
</script>

<template>
  <header class="qb-glass sticky top-0 z-30 border-x-0 border-t-0 pt-[env(safe-area-inset-top)] md:hidden">
    <div class="flex h-13 items-center gap-2 pr-[max(0.5rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))]">
      <BrandMark class="size-5 shrink-0" />
      <span class="text-sm font-semibold tracking-tight text-fg">部署向导</span>
      <span class="min-w-0 truncate text-xs text-fg-muted tabular-nums">{{ label }}</span>
      <span class="flex-1" />
      <ThemeToggle />
      <button
        type="button"
        class="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md transition-[background-color,transform] duration-(--qb-duration) active:scale-90 disabled:opacity-50"
        :class="finished ? 'text-fg-muted' : 'text-danger'"
        :aria-label="finished ? '关闭向导' : '终止向导'"
        :disabled="busy"
        @click="leave"
      >
        <Power class="size-4" aria-hidden="true" />
      </button>
    </div>
    <div class="flex gap-1 pr-[max(1rem,env(safe-area-inset-right))] pb-2.5 pl-[max(1rem,env(safe-area-inset-left))]" aria-hidden="true">
      <span v-for="s in tasks" :key="s.id" class="h-1 flex-1 overflow-hidden rounded-full bg-border">
        <span
          class="block h-full rounded-full transition-transform duration-(--qb-duration-slower) ease-out"
          :class="s.state === 'error' ? 'bg-danger' : 'bg-accent'"
          :style="{ transform: `scaleX(${s.state === 'error' ? 1 : fill(s)})`, transformOrigin: 'left' }"
        />
      </span>
    </div>
  </header>
</template>
