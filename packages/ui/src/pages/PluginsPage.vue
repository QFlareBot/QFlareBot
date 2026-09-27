<script setup lang="ts">
/**
 * 插件页：已装插件放最上面；安装在「添加插件」（/market）里做；
 * 构建相关的（进行中提示、未上线的改动、构建记录）放在列表前后，平时只占一行。
 */
import { Blocks, Plus, RefreshCw } from 'lucide-vue-next'
import { api } from '../api/client.js'
import type { PluginInfo } from '../api/types.js'
import PageHeader from '../components/PageHeader.vue'
import BuildHistoryCard from '../components/plugins/BuildHistoryCard.vue'
import PendingChangesCard from '../components/plugins/PendingChangesCard.vue'
import PluginRow from '../components/plugins/PluginRow.vue'
import QButton from '../components/ui/QButton.vue'
import QCard from '../components/ui/QCard.vue'
import QCollapse from '../components/ui/QCollapse.vue'
import QEmpty from '../components/ui/QEmpty.vue'
import QSkeleton from '../components/ui/QSkeleton.vue'
import { useBuildState } from '../composables/useBuildState.js'
import { usePluginUpdates } from '../composables/usePluginUpdates.js'
import { useStatus } from '../composables/useStatus.js'
import { useToast } from '../composables/useToast.js'

const { status, plugins, patchLocal, refresh } = useStatus()
const { push } = useToast()
const build = useBuildState()
const updates = usePluginUpdates(build)

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
</script>

<template>
  <div>
    <PageHeader title="插件" description="开关即时生效。新插件从「添加插件」安装，构建机编译完自动上线。">
      <QButton size="sm" :loading="updates.checkingAll.value" :disabled="!updates.checkable.value.length || updates.updatingBatch.value" @click="updates.checkAll">
        <RefreshCw class="size-3.5" aria-hidden="true" />检查全部更新
      </QButton>
      <RouterLink to="/market" tabindex="-1"><QButton size="sm" variant="primary"><Plus class="size-3.5" aria-hidden="true" />添加插件</QButton></RouterLink>
    </PageHeader>

    <QCollapse :open="build.building.value">
      <p class="relative mb-4 flex items-center gap-2.5 overflow-hidden rounded-lg bg-warning-bg px-4 py-2.5 text-sm text-warning" role="status">
        <span class="qb-pulse size-2 shrink-0 rounded-full bg-warning" aria-hidden="true" />
        有构建正在进行，完成后这里会自动刷新。
        <span class="qb-progress" aria-hidden="true" />
      </p>
    </QCollapse>

    <QCollapse :open="!!build.changes.value.length">
      <div class="pb-4"><PendingChangesCard :build="build" /></div>
    </QCollapse>

    <QCard flush title="已装插件" :description="plugins.length ? `${plugins.length} 个` : undefined">
      <template #actions>
        <QButton v-if="updates.selectedCount.value" size="sm" variant="primary" class="qb-pop" :loading="updates.updatingBatch.value" @click="updates.updateSelected">
          更新选中（{{ updates.selectedCount.value }}）
        </QButton>
      </template>
      <QSkeleton v-if="!status" :rows="3" label="正在读取插件列表" />
      <QEmpty v-else-if="!plugins.length" :icon="Blocks" title="还没有插件" description="从插件市场挑几个，或粘贴插件仓库的链接。">
        <RouterLink to="/market" tabindex="-1"><QButton size="sm" variant="primary"><Plus class="size-3.5" aria-hidden="true" />添加插件</QButton></RouterLink>
      </QEmpty>
      <ul v-else class="divide-y divide-border">
        <PluginRow v-for="p in plugins" :key="p.name" :plugin="p" :build="build" :updates="updates" @toggle="toggle(p, $event)" />
      </ul>
    </QCard>

    <div class="mt-4"><BuildHistoryCard :build="build" /></div>
  </div>
</template>
