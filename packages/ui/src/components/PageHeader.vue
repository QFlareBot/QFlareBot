<script setup lang="ts">
defineProps<{ title: string; description?: string }>()
</script>

<template>
  <header class="mb-4 flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 class="text-xl font-semibold tracking-tight text-fg">{{ title }}</h1>
      <p v-if="description" class="mt-0.5 text-sm text-fg-muted">{{ description }}</p>
    </div>
    <div v-if="$slots.default" class="flex items-center gap-2"><slot /></div>
  </header>
</template>
