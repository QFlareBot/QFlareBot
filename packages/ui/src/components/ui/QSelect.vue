<script setup lang="ts">
defineProps<{ modelValue: string; options: Array<{ value: string; label: string }>; id?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
</script>

<template>
  <select
    :id="id"
    :value="modelValue"
    class="h-8 w-full rounded-md border border-border-strong bg-surface px-2 text-sm text-fg"
    @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
  >
    <option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option>
  </select>
</template>
