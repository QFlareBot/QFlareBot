<script setup lang="ts">
withDefaults(defineProps<{ tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'accent' }>(), { tone: 'neutral' })
</script>

<template>
  <span
    class="inline-flex h-5 items-center rounded-sm px-1.5 text-xs font-medium whitespace-nowrap"
    :class="{
      neutral: 'bg-surface-muted text-fg-muted',
      success: 'bg-success-bg text-success',
      warning: 'bg-warning-bg text-warning',
      danger: 'bg-danger-bg text-danger',
      accent: 'bg-success-bg text-accent',
    }[tone]"
  >
    <slot />
  </span>
</template>
