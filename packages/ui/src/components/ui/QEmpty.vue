<script setup lang="ts">
/** 空状态：可选图标，默认插槽放下一步的按钮 */
import type { Component } from 'vue'

defineProps<{ title: string; description?: string; icon?: Component }>()
</script>

<template>
  <div class="flex flex-col items-center justify-center gap-1 px-4 py-12 text-center">
    <span v-if="icon" class="mb-2 flex size-10 items-center justify-center rounded-lg bg-surface-muted text-fg-muted" aria-hidden="true">
      <component :is="icon" class="size-5" />
    </span>
    <p class="text-sm font-medium text-balance text-fg">{{ title }}</p>
    <p v-if="description" class="max-w-sm text-xs text-pretty text-fg-muted">{{ description }}</p>
    <div v-if="$slots.default" class="mt-3 flex flex-wrap justify-center gap-2"><slot /></div>
  </div>
</template>
