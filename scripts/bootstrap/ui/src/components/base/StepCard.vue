<script setup lang="ts">
/** 向导里的卡片：比面板的 QCard 留白多一点，一屏只做一件事 */
defineProps<{ title?: string; description?: string }>()
</script>

<template>
  <section class="relative overflow-hidden rounded-lg border border-card-border bg-surface shadow-card">
    <header v-if="title || $slots.actions" class="flex items-start justify-between gap-3 px-5 pt-5 md:px-6">
      <div class="min-w-0">
        <h2 v-if="title" class="text-sm font-semibold text-fg">{{ title }}</h2>
        <p v-if="description" class="mt-0.5 text-xs text-pretty text-fg-muted">{{ description }}</p>
      </div>
      <div v-if="$slots.actions" class="flex shrink-0 items-center gap-2"><slot name="actions" /></div>
    </header>
    <div :class="title || $slots.actions ? 'px-5 pt-4 pb-5 md:px-6 md:pb-6' : 'p-5 md:p-6'"><slot /></div>
  </section>
</template>
