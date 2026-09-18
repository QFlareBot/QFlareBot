<script setup lang="ts">
defineProps<{ title: string; description?: string }>()
</script>

<template>
  <div class="flex flex-col items-center justify-center gap-1 px-4 py-12 text-center">
    <p class="text-sm font-medium text-fg">{{ title }}</p>
    <p v-if="description" class="max-w-sm text-xs text-fg-muted">{{ description }}</p>
    <div v-if="$slots.default" class="mt-3"><slot /></div>
  </div>
</template>
