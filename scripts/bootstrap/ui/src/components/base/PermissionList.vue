<script setup lang="ts">
/** 预填链接里的权限清单；验证时缺了哪项就把哪项标红 */
import { CircleX, KeyRound } from 'lucide-vue-next'

defineProps<{ items: Array<{ key: string; name: string; level: string; note?: string }>; missing?: string[] }>()
</script>

<template>
  <ul class="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
    <li
      v-for="item in items"
      :key="item.key"
      class="flex min-w-0 items-center gap-2.5 rounded-md border px-3 py-2 text-xs transition-colors duration-(--qb-duration-slow)"
      :class="missing?.includes(item.key) ? 'border-danger/35 bg-danger-bg' : 'border-border'"
      :title="item.note"
    >
      <CircleX v-if="missing?.includes(item.key)" class="qb-pop size-3.5 shrink-0 text-danger" aria-label="缺少" />
      <KeyRound v-else class="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
      <span class="min-w-0 flex-1 truncate text-fg">{{ item.name }}</span>
      <span class="shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-fg-muted">{{ item.level }}</span>
    </li>
  </ul>
</template>
