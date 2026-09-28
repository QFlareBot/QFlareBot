<script setup lang="ts">
/** 卡片里编号的小步骤；做完的换成对勾，步骤之间有一条细线连着 */
import { Check } from 'lucide-vue-next'

defineProps<{ n: number; title: string; done?: boolean; last?: boolean }>()
</script>

<template>
  <div class="relative flex gap-3.5" :class="!last && 'pb-6'">
    <span v-if="!last" class="absolute top-8 bottom-1.5 left-3 w-px bg-border" aria-hidden="true" />
    <span
      class="relative flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums transition-colors duration-(--qb-duration-slow)"
      :class="done ? 'bg-accent text-on-accent' : 'bg-surface-muted text-fg-muted ring-1 ring-border-strong ring-inset'"
      aria-hidden="true"
    >
      <Check v-if="done" class="qb-pop size-3.5" :stroke-width="3" />
      <template v-else>{{ n }}</template>
    </span>
    <div class="min-w-0 flex-1 pt-0.5">
      <p class="text-sm font-medium text-fg">{{ title }}</p>
      <div v-if="$slots.default" class="mt-2"><slot /></div>
    </div>
  </div>
</template>
