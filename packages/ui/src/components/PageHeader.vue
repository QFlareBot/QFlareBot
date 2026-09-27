<script setup lang="ts">
defineProps<{ title: string; description?: string }>()
</script>

<template>
  <header class="mb-5 flex flex-wrap items-end justify-between gap-3">
    <div class="min-w-0">
      <h1 class="text-2xl font-semibold tracking-tight text-balance text-fg">{{ title }}</h1>
      <p v-if="description" class="mt-1 max-w-2xl text-sm text-pretty text-fg-muted">{{ description }}</p>
    </div>
    <div v-if="$slots.default" class="flex items-center gap-2"><slot /></div>
  </header>
</template>
