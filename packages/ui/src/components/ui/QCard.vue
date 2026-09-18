<script setup lang="ts">
/** flush：内容区不留内边距（表格、列表直接贴边） */
defineProps<{ title?: string; description?: string; flush?: boolean }>()
</script>

<template>
  <section class="rounded-lg border border-border bg-surface shadow-(--qb-shadow)">
    <header v-if="title || $slots.actions" class="flex min-h-11 items-center justify-between gap-3 border-b border-border px-4">
      <div class="min-w-0">
        <h2 v-if="title" class="text-sm font-medium text-fg">{{ title }}</h2>
        <p v-if="description" class="truncate text-xs text-fg-muted">{{ description }}</p>
      </div>
      <div v-if="$slots.actions" class="flex shrink-0 items-center gap-2"><slot name="actions" /></div>
    </header>
    <div :class="!flush && 'p-4'"><slot /></div>
  </section>
</template>
