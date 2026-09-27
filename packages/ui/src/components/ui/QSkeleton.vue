<script setup lang="ts">
/** 列表加载占位：rows 行，每行一条标题一条说明，宽度错开，看着像真内容 */
withDefaults(defineProps<{ rows?: number; label?: string }>(), { rows: 4, label: '正在加载' })
const WIDTHS = ['62%', '48%', '71%', '55%', '66%', '44%']
</script>

<template>
  <div role="status" :aria-label="label" class="divide-y divide-border">
    <div v-for="i in rows" :key="i" class="flex flex-col gap-2 px-4 py-3.5" aria-hidden="true">
      <span class="qb-skeleton h-3.5" :style="{ width: WIDTHS[(i - 1) % WIDTHS.length] }" />
      <span class="qb-skeleton h-3 w-1/3 opacity-70" />
    </div>
  </div>
</template>
