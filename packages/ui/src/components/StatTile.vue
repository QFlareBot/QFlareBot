<script setup lang="ts">
/** 概览顶部的数字卡片；给了 to 就是链接，悬停会抬起来，没给就是纯展示 */
import type { Component } from 'vue'

defineProps<{ label: string; icon: Component; to?: string; hint?: string }>()
</script>

<template>
  <component
    :is="to ? 'RouterLink' : 'div'"
    :to="to"
    :title="hint"
    class="block rounded-lg border border-card-border bg-surface p-4 shadow-card"
    :class="to && 'transition-[transform,box-shadow] duration-(--qb-duration-slow) ease-out hover:-translate-y-0.5 hover:shadow-card-hover'"
  >
    <p class="flex items-center gap-2 text-xs text-fg-muted">
      <span class="flex size-6 items-center justify-center rounded-md bg-surface-muted" aria-hidden="true"><component :is="icon" class="size-3.5" /></span>
      {{ label }}
    </p>
    <div class="mt-2.5 min-h-8"><slot /></div>
    <p v-if="$slots.foot" class="mt-0.5 truncate text-xs text-fg-subtle"><slot name="foot" /></p>
  </component>
</template>
