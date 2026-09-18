<script setup lang="ts">
defineProps<{ modelValue: boolean; disabled?: boolean; label?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
</script>

<template>
  <!-- 视觉 20px 高，点击热区补到 44px -->
  <button
    type="button"
    role="switch"
    :aria-checked="modelValue"
    :aria-label="label"
    :disabled="disabled"
    class="relative inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center disabled:cursor-not-allowed disabled:opacity-50"
    @click="emit('update:modelValue', !modelValue)"
  >
    <span
      class="relative inline-block h-5 w-9 rounded-full transition-colors duration-(--qb-duration) ease-(--qb-ease)"
      :class="modelValue ? 'bg-accent' : 'bg-border-strong'"
    >
      <span
        class="absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow-sm transition-transform duration-(--qb-duration) ease-(--qb-ease)"
        :class="modelValue && 'translate-x-4'"
      />
    </span>
  </button>
</template>
