<script setup lang="ts">
defineProps<{ modelValue: string; rows?: number; id?: string; mono?: boolean; placeholder?: string; invalid?: boolean; describedBy?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
</script>

<template>
  <textarea
    :id="id"
    :rows="rows ?? 4"
    :value="modelValue"
    :placeholder="placeholder"
    :aria-invalid="invalid || undefined"
    :aria-describedby="describedBy"
    class="w-full rounded-md border bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-subtle"
    :class="[invalid ? 'border-danger' : 'border-border-strong', mono && 'font-mono text-xs leading-relaxed']"
    @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
  />
</template>
