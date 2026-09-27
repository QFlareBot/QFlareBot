<script setup lang="ts">
defineProps<{ modelValue: boolean; disabled?: boolean; label?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
</script>

<template>
  <!-- 视觉 20px 高，点击热区补到 44px；按住时圆钮拉长，松手弹到另一侧 -->
  <button
    type="button"
    role="switch"
    :aria-checked="modelValue"
    :aria-label="label"
    :disabled="disabled"
    class="group relative inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center disabled:cursor-not-allowed disabled:opacity-50"
    @click="emit('update:modelValue', !modelValue)"
  >
    <span
      class="relative inline-block h-5 w-9 rounded-full transition-colors duration-(--qb-duration-slow) ease-(--qb-ease)"
      :class="modelValue ? 'bg-accent' : 'bg-border-strong'"
    >
      <span
        class="absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.25)] transition-[transform,width] duration-(--qb-duration-slow) ease-spring group-enabled:group-active:w-5"
        :class="modelValue && 'translate-x-4 group-enabled:group-active:translate-x-3'"
      />
    </span>
  </button>
</template>
