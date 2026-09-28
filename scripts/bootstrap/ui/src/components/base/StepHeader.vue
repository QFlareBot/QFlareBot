<script setup lang="ts">
/** 每一步的标题：图标、「第几步」、标题、一句话说明。标题可聚焦，切步骤后读屏从这里读起 */
import type { Component } from 'vue'
import { TASK_COUNT } from '../../lib/steps.js'

defineProps<{ icon: Component; index?: number; title: string; description: string }>()
</script>

<template>
  <header class="mb-2 flex items-start gap-4">
    <span
      class="flex size-11 shrink-0 items-center justify-center rounded-[14px] bg-primary text-on-primary ring-1 ring-accent/15 ring-inset"
      aria-hidden="true"
    >
      <component :is="icon" class="size-5" />
    </span>
    <div class="min-w-0 pt-px">
      <p v-if="index" class="text-xs font-medium text-accent tabular-nums">第 {{ index }} 步 · 共 {{ TASK_COUNT }} 步</p>
      <h1 data-step-title tabindex="-1" class="mt-0.5 text-2xl font-semibold tracking-tight text-balance text-fg outline-none">{{ title }}</h1>
      <p class="mt-1 max-w-xl text-sm text-pretty text-fg-muted">{{ description }}</p>
    </div>
  </header>
</template>
