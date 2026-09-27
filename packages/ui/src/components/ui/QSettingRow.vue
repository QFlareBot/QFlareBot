<script setup lang="ts">
/** 设置项：左边名称与说明，右边控件；窄屏上下排。放在带 divide-y 的容器里 */
defineProps<{ title: string; description?: string; for?: string }>()
</script>

<template>
  <div class="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
    <div class="min-w-0 sm:max-w-md">
      <label v-if="$props.for" :for="$props.for" class="text-sm font-medium text-fg">{{ title }}</label>
      <p v-else class="text-sm font-medium text-fg">{{ title }}</p>
      <p v-if="description" class="mt-0.5 text-xs text-pretty text-fg-muted">{{ description }}</p>
      <slot name="extra" />
    </div>
    <div class="flex shrink-0 items-center gap-2"><slot /></div>
  </div>
</template>
