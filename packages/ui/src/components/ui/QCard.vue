<script setup lang="ts">
/** flush：内容区不留内边距（表格、列表直接贴边） */
defineProps<{ title?: string; description?: string; flush?: boolean }>()
</script>

<template>
  <section class="rounded-lg border border-card-border bg-surface shadow-card">
    <header v-if="title || $slots.actions" class="flex min-h-12 items-center justify-between gap-3 px-4 pt-3.5 pb-2.5">
      <div class="min-w-0">
        <h2 v-if="title" class="text-sm font-semibold text-fg">{{ title }}</h2>
        <p v-if="description" class="mt-0.5 text-xs text-pretty text-fg-muted">{{ description }}</p>
      </div>
      <div v-if="$slots.actions" class="flex shrink-0 items-center gap-2"><slot name="actions" /></div>
    </header>
    <div :class="flush ? 'border-t border-border' : title || $slots.actions ? 'px-4 pt-1 pb-4' : 'p-4'"><slot /></div>
  </section>
</template>
