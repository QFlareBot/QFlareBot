<script setup lang="ts">
defineProps<{
  modelValue: string | number
  type?: string
  placeholder?: string
  id?: string
  disabled?: boolean
  mono?: boolean
  invalid?: boolean
  describedBy?: string
  autocomplete?: string
}>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
</script>

<template>
  <input
    :id="id"
    :type="type ?? 'text'"
    :value="modelValue"
    :placeholder="placeholder"
    :disabled="disabled"
    :autocomplete="autocomplete"
    :aria-invalid="invalid || undefined"
    :aria-describedby="describedBy"
    class="h-8 w-full rounded-md border bg-surface px-3 text-sm text-fg placeholder:text-fg-subtle disabled:opacity-50"
    :class="[invalid ? 'border-danger' : 'border-border-strong', mono && 'font-mono']"
    @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
  />
</template>
