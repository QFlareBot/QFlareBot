<script setup lang="ts">
import { ChevronRight } from 'lucide-vue-next'
import { api } from '../api/client.js'
import type { PluginInfo } from '../api/types.js'
import PageHeader from '../components/PageHeader.vue'
import QBadge from '../components/ui/QBadge.vue'
import QCard from '../components/ui/QCard.vue'
import QEmpty from '../components/ui/QEmpty.vue'
import QSwitch from '../components/ui/QSwitch.vue'
import { useStatus } from '../composables/useStatus.js'
import { useToast } from '../composables/useToast.js'

const { plugins, patchLocal, refresh } = useStatus()
const { push } = useToast()

async function toggle(p: PluginInfo, enabled: boolean) {
  patchLocal(p.name, { enabled })
  try {
    await api.patchPlugin(p.name, { enabled })
    push(`${p.displayName} 已${enabled ? '启用' : '禁用'}`, 'success')
  } catch (e) {
    patchLocal(p.name, { enabled: !enabled })
    push(`操作失败：${(e as Error).message}`, 'error')
  } finally {
    void refresh()
  }
}

function summary(p: PluginInfo): string[] {
  const parts: string[] = []
  if (p.commands.length) parts.push(`${p.commands.length} 个命令`)
  if (p.events.length) parts.push(`${p.events.length} 个事件`)
  if (p.buttons.length) parts.push(`${p.buttons.length} 个按键`)
  if (p.cron.length) parts.push(`${p.cron.length} 个定时`)
  if (p.routes.length) parts.push(`${p.routes.length} 个路由`)
  return parts
}
</script>

<template>
  <div>
    <PageHeader title="插件" description="启用 / 禁用即时生效，不需要重新部署。安装新插件需要重新投影部署（M2 面板内安装尚未完成）。" />
    <QCard flush>
      <QEmpty v-if="!plugins.length" title="没有已安装的插件" description="在 apps/seed 的清单里加入插件后重新部署。" />
      <ul v-else class="divide-y divide-border">
        <li v-for="p in plugins" :key="p.name" class="flex items-center gap-2 pr-2 pl-4">
          <QSwitch :model-value="p.enabled" :label="`${p.enabled ? '禁用' : '启用'} ${p.displayName}`" :disabled="!!p.error" @update:model-value="toggle(p, $event)" />
          <RouterLink :to="`/plugins/${p.name}`" class="flex min-w-0 flex-1 items-center gap-3 py-2.5 hover:text-fg">
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="text-sm font-medium text-fg">{{ p.displayName }}</span>
                <span class="font-mono text-xs text-fg-subtle">{{ p.name }}@{{ p.version }}</span>
                <QBadge v-if="p.error" tone="danger">加载失败</QBadge>
                <QBadge v-else-if="!p.enabled" tone="neutral">已禁用</QBadge>
                <QBadge v-if="p.ui" tone="accent">有页面</QBadge>
              </div>
              <p class="truncate text-xs text-fg-muted">{{ p.error ?? p.description ?? summary(p).join(' · ') }}</p>
            </div>
            <span class="hidden text-xs text-fg-subtle sm:block">{{ summary(p).join(' · ') }}</span>
            <ChevronRight class="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
          </RouterLink>
        </li>
      </ul>
    </QCard>
  </div>
</template>
