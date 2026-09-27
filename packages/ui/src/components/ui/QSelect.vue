<script setup lang="ts">
defineProps<{ modelValue: string; options: Array<{ value: string; label: string }>; id?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
</script>

<template>
  <select
    :id="id"
    :value="modelValue"
    class="qb-control h-8 w-full cursor-pointer px-2.5 text-sm"
    @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
  >
    <option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option>
  </select>
</template>
