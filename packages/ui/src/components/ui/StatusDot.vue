<script setup lang="ts">
/** 状态点永远配文字，不靠颜色单独传达；pulse 用于「正在进行」（实时调试、构建中） */
withDefaults(defineProps<{ tone: 'success' | 'warning' | 'danger' | 'neutral'; label: string; pulse?: boolean }>(), {})
</script>

<template>
  <span class="inline-flex items-center gap-1.5 text-sm">
    <span
      class="size-2 shrink-0 rounded-full"
      :class="[{ success: 'bg-success', warning: 'bg-warning', danger: 'bg-danger', neutral: 'bg-fg-subtle' }[tone], pulse && 'qb-pulse']"
      aria-hidden="true"
    />
    <span>{{ label }}</span>
  </span>
</template>
