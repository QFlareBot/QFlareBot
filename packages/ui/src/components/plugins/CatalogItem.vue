<script setup lang="ts">
/** 插件目录里的一项：勾选、名称与标签、作者和更新时间、单独安装 */
import { ExternalLink } from 'lucide-vue-next'
import { computed } from 'vue'
import type { CatalogPlugin } from '../../lib/catalog.js'
import QBadge from '../ui/QBadge.vue'
import QButton from '../ui/QButton.vue'

const props = defineProps<{
  plugin: CatalogPlugin
  installed?: { pending: boolean }
  /** 装着同名插件、但来源是另一个仓库 */
  installedFrom: string | null
  selected: boolean
  disabled: boolean
  loading: boolean
}>()
const emit = defineEmits<{ select: [on: boolean]; install: [] }>()

const meta = computed(() => {
  const p = props.plugin
  return [
    p.author,
    p.stars !== undefined ? `★ ${p.stars}` : '',
    p.license ?? '',
    p.updatedAt ? `${new Date(p.updatedAt).toLocaleDateString('zh-CN')} 更新` : '',
    p.permissions?.length ? `权限：${p.permissions.join('、')}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
})
</script>

<template>
  <li class="flex items-start gap-3 px-4 py-3.5">
    <input
      type="checkbox"
      class="mt-0.5"
      :checked="selected"
      :disabled="!!installed || disabled"
      :aria-label="`选中 ${plugin.displayName ?? plugin.name}`"
      @change="emit('select', ($event.target as HTMLInputElement).checked)"
    />
    <div class="min-w-0 flex-1">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span class="text-sm font-medium text-fg">{{ plugin.displayName ?? plugin.name }}</span>
        <span class="font-mono text-xs text-fg-subtle">{{ plugin.name }}{{ plugin.version ? `@${plugin.version}` : '' }}</span>
        <QBadge v-if="installed?.pending" tone="warning">待上线</QBadge>
        <QBadge v-else-if="installed" tone="success">已安装</QBadge>
        <QBadge v-if="plugin.status === 'error'" tone="warning">目录最近没读到</QBadge>
        <QBadge v-for="t in plugin.tags ?? []" :key="t">{{ t }}</QBadge>
      </div>
      <p v-if="plugin.description" class="mt-1 text-xs text-fg-muted">{{ plugin.description }}</p>
      <p class="mt-0.5 text-xs text-fg-subtle">{{ meta }}</p>
      <p v-if="installedFrom" class="mt-0.5 text-xs text-fg-subtle">已装的这份来自 {{ installedFrom }}</p>
      <p v-if="plugin.status === 'error' && plugin.error" class="mt-0.5 text-xs text-warning">{{ plugin.error }}</p>
    </div>
    <div class="flex shrink-0 items-center gap-1">
      <QButton v-if="!installed" size="sm" :loading="loading" :disabled="disabled" @click="emit('install')">安装</QButton>
      <a
        :href="`https://github.com/${plugin.repo}`"
        target="_blank"
        rel="noopener"
        class="flex size-7 items-center justify-center rounded-full text-fg-subtle transition-colors duration-(--qb-duration) hover:bg-surface-muted hover:text-fg"
        :aria-label="`${plugin.displayName ?? plugin.name} 的仓库`"
      >
        <ExternalLink class="size-4" aria-hidden="true" />
      </a>
    </div>
  </li>
</template>
