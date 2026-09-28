<script setup lang="ts" generic="T extends string">
/** 几个互斥选项，做成带说明的单选卡片（比一排单选框好读） */
defineProps<{ name: string; options: Array<{ value: T; title: string; description?: string }> }>()
const model = defineModel<T>({ required: true })
</script>

<template>
  <div class="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup">
    <label
      v-for="o in options"
      :key="o.value"
      class="flex cursor-pointer items-start gap-3 rounded-md border px-3.5 py-3 transition-[background-color,border-color] duration-(--qb-duration)"
      :class="model === o.value ? 'border-accent/50 bg-primary/50' : 'border-border hover:bg-surface-muted'"
    >
      <input v-model="model" type="radio" :name="name" :value="o.value" class="mt-0.5 size-4 shrink-0 cursor-pointer" />
      <span class="min-w-0">
        <span class="block text-sm font-medium text-fg">{{ o.title }}</span>
        <span v-if="o.description" class="mt-0.5 block text-xs text-pretty text-fg-muted">{{ o.description }}</span>
      </span>
    </label>
  </div>
</template>
