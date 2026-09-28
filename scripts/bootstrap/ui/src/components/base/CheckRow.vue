<script setup lang="ts">
/** 状态清单的一行：圆形状态图标 + 标题 + 说明，可带一个外链 */
import { ArrowUpRight, Check, TriangleAlert, X } from 'lucide-vue-next'
import type { RowState } from '../../lib/build.js'
import Spinner from './Spinner.vue'

defineProps<{ state: RowState; title: string; detail?: string; href?: string | null; linkText?: string }>()
</script>

<template>
  <li class="flex items-start gap-3">
    <span
      class="mt-px flex size-6 shrink-0 items-center justify-center rounded-full"
      :class="{ ok: 'bg-success-bg text-success', run: 'bg-primary text-accent', warn: 'bg-warning-bg text-warning', fail: 'bg-danger-bg text-danger' }[state]"
      aria-hidden="true"
    >
      <Transition name="swap" type="transition" mode="out-in">
        <Spinner v-if="state === 'run'" key="run" class="size-3" />
        <Check v-else-if="state === 'ok'" key="ok" class="size-3.5" :stroke-width="3" />
        <TriangleAlert v-else-if="state === 'warn'" key="warn" class="size-3.5" />
        <X v-else key="fail" class="size-3.5" :stroke-width="3" />
      </Transition>
    </span>
    <div class="min-w-0 flex-1 pt-0.5">
      <p class="text-sm font-medium text-pretty text-fg">{{ title }}</p>
      <p v-if="detail || $slots.default" class="mt-0.5 text-xs text-pretty break-words text-fg-muted"><slot>{{ detail }}</slot></p>
      <a
        v-if="href"
        :href="href"
        target="_blank"
        rel="noopener noreferrer"
        class="mt-1 inline-flex items-center gap-0.5 text-xs font-medium text-accent underline-offset-2 hover:underline"
      >
        {{ linkText ?? '构建记录' }}<ArrowUpRight class="size-3.5" aria-hidden="true" />
      </a>
    </div>
  </li>
</template>
