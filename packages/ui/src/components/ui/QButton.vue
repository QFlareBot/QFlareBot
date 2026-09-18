<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
    size?: 'sm' | 'md'
    type?: 'button' | 'submit'
    disabled?: boolean
    loading?: boolean
  }>(),
  { variant: 'secondary', size: 'md', type: 'button' },
)

const classes = computed(() => [
  'inline-flex items-center justify-center gap-2 rounded-md border font-medium whitespace-nowrap select-none',
  'transition-[background-color,border-color,opacity] duration-(--qb-duration) ease-(--qb-ease)',
  'disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer',
  props.size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm',
  {
    primary: 'bg-accent border-accent text-on-accent hover:brightness-95',
    secondary: 'bg-surface border-border-strong text-fg hover:bg-surface-muted',
    ghost: 'bg-transparent border-transparent text-fg-muted hover:bg-surface-muted hover:text-fg',
    danger: 'bg-surface border-border-strong text-danger hover:bg-danger-bg',
  }[props.variant],
])
</script>

<template>
  <button :type="type" :class="classes" :disabled="disabled || loading" :aria-busy="loading || undefined">
    <span v-if="loading" class="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
    <slot />
  </button>
</template>
