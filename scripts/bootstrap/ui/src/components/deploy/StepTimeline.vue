<script setup lang="ts">
/** 部署的每一步：状态图标、名字、报错、用时；正在跑的那一行浅底高亮、实时走表 */
import { Check, TriangleAlert, X } from 'lucide-vue-next'
import { formatDuration, serverNow } from '../../lib/clock.js'
import { SLOW_STEPS } from '../../lib/steps.js'
import type { ProgressStep } from '../../types.js'
import Spinner from '../base/Spinner.vue'

defineProps<{ steps: ProgressStep[] }>()
const elapsed = (s: ProgressStep) => formatDuration((s.endedAt ?? serverNow.value) - s.startedAt)
</script>

<template>
  <div v-if="!steps.length" class="space-y-3 py-1" aria-label="正在启动">
    <div v-for="i in 3" :key="i" class="flex items-center gap-3">
      <span class="qb-skeleton block size-5 rounded-full!" />
      <span class="qb-skeleton block h-3.5 flex-1" :style="{ maxWidth: `${60 - i * 12}%` }" />
    </div>
  </div>
  <TransitionGroup v-else name="list" tag="ol" class="-mx-2 space-y-0.5">
    <li
      v-for="(s, i) in steps"
      :key="`${i}-${s.name}`"
      class="flex items-start gap-3 rounded-md px-2 py-2 transition-colors duration-(--qb-duration-slow)"
      :class="s.state === 'run' && 'bg-surface-muted'"
    >
      <span
        class="mt-px flex size-5 shrink-0 items-center justify-center rounded-full"
        :class="{ run: 'text-accent', ok: 'bg-success-bg text-success', warn: 'bg-warning-bg text-warning', fail: 'bg-danger-bg text-danger' }[s.state]"
        aria-hidden="true"
      >
        <Transition name="swap" type="transition" mode="out-in">
          <Spinner v-if="s.state === 'run'" key="run" class="size-3.5" />
          <Check v-else-if="s.state === 'ok'" key="ok" class="size-3" :stroke-width="3.2" />
          <TriangleAlert v-else-if="s.state === 'warn'" key="warn" class="size-3" />
          <X v-else key="fail" class="size-3" :stroke-width="3.2" />
        </Transition>
      </span>
      <div class="min-w-0 flex-1">
        <p class="text-sm text-fg" :class="s.state === 'run' && 'font-medium'">{{ s.name }}</p>
        <p v-if="s.state === 'run' && SLOW_STEPS[s.name]" class="mt-0.5 text-xs text-fg-muted">{{ SLOW_STEPS[s.name] }}</p>
        <p v-if="s.detail" class="mt-0.5 text-xs break-words" :class="s.state === 'fail' ? 'text-danger' : 'text-warning'">{{ s.detail }}</p>
      </div>
      <span class="shrink-0 pt-px font-mono text-xs text-fg-subtle tabular-nums">{{ elapsed(s) }}</span>
    </li>
  </TransitionGroup>
</template>
