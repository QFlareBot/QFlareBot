<script setup lang="ts">
/** 步骤栏上的圆点：数字 / 对勾 / 进行中 / 失败 / 跳过 */
import { Check, Minus, X } from 'lucide-vue-next'
import type { NodeState } from '../../composables/useStepStatus.js'
import Spinner from '../base/Spinner.vue'

defineProps<{ state: NodeState; n: number; current: boolean }>()
</script>

<template>
  <span
    class="relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums transition-[background-color,color,box-shadow] duration-(--qb-duration-slow)"
    :class="{
      done: 'bg-accent text-on-accent',
      running: 'bg-surface text-accent ring-2 ring-accent ring-inset',
      error: 'bg-danger-bg text-danger ring-1 ring-danger/40 ring-inset',
      skipped: 'bg-surface-muted text-fg-subtle',
      todo: current ? 'bg-surface text-accent ring-2 ring-accent ring-inset' : 'bg-surface text-fg-subtle ring-1 ring-border-strong ring-inset',
    }[state]"
    aria-hidden="true"
  >
    <Transition name="swap" type="transition" mode="out-in">
      <Check v-if="state === 'done'" key="done" class="size-3.5" :stroke-width="3" />
      <Spinner v-else-if="state === 'running'" key="running" class="size-3" />
      <X v-else-if="state === 'error'" key="error" class="size-3.5" :stroke-width="3" />
      <Minus v-else-if="state === 'skipped'" key="skipped" class="size-3.5" />
      <span v-else key="todo">{{ n }}</span>
    </Transition>
  </span>
</template>
