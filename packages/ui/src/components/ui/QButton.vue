<script setup lang="ts">
import { computed } from 'vue'

/** danger 是浅红底（列表里的删除），destructive 是实心红（对话框里的最终确认） */
const props = withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'destructive'
    size?: 'sm' | 'md'
    type?: 'button' | 'submit'
    disabled?: boolean
    loading?: boolean
  }>(),
  { variant: 'secondary', size: 'md', type: 'button' },
)

const classes = computed(() => [
  'inline-flex items-center justify-center gap-1.5 rounded-full border font-medium whitespace-nowrap select-none cursor-pointer',
  'transition-[background-color,border-color,color,opacity,transform] duration-(--qb-duration) ease-(--qb-ease) enabled:active:scale-[0.97]',
  'disabled:opacity-50 disabled:cursor-not-allowed',
  props.size === 'sm' ? 'h-7 px-3 text-xs' : 'h-8 px-4 text-sm',
  {
    primary: 'bg-accent border-accent text-on-accent enabled:hover:opacity-90',
    secondary: 'bg-surface border-border-strong text-fg shadow-[0_1px_2px_rgb(0_0_0/0.04)] enabled:hover:bg-surface-muted',
    ghost: 'bg-transparent border-transparent text-fg-muted enabled:hover:bg-surface-muted enabled:hover:text-fg',
    danger: 'bg-danger-bg border-transparent text-danger enabled:hover:bg-danger/15',
    destructive: 'bg-danger border-danger text-white enabled:hover:opacity-90',
  }[props.variant],
])
</script>

<template>
  <button :type="type" :class="classes" :disabled="disabled || loading" :aria-busy="loading || undefined">
    <span v-if="loading" class="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
    <slot />
  </button>
</template>
