<script setup lang="ts">
/** 插件详情：左边是插件配置与运行规则（各自保存），右边是信息与触发器，最下面是卸载 */
import { ArrowLeft, PanelsTopLeft, SearchX } from 'lucide-vue-next'
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '../api/client.js'
import PageHeader from '../components/PageHeader.vue'
import PluginConfigCard from '../components/plugins/PluginConfigCard.vue'
import PluginRulesCard from '../components/plugins/PluginRulesCard.vue'
import TriggerList from '../components/plugins/TriggerList.vue'
import UninstallCard from '../components/plugins/UninstallCard.vue'
import QBadge from '../components/ui/QBadge.vue'
import QButton from '../components/ui/QButton.vue'
import QCard from '../components/ui/QCard.vue'
import QEmpty from '../components/ui/QEmpty.vue'
import QSkeleton from '../components/ui/QSkeleton.vue'
import QSwitch from '../components/ui/QSwitch.vue'
import { useStatus } from '../composables/useStatus.js'
import { useToast } from '../composables/useToast.js'

const route = useRoute()
const { pluginByName, refresh, status, patchLocal } = useStatus()
const { push } = useToast()
const plugin = computed(() => pluginByName(String(route.params.name)))

async function toggle(enabled: boolean) {
  if (!plugin.value) return
  patchLocal(plugin.value.name, { enabled })
  try {
    await api.patchPlugin(plugin.value.name, { enabled })
  } catch (e) {
    push(`操作失败：${(e as Error).message}`, 'error')
  } finally {
    void refresh()
  }
}
</script>

<template>
  <div>
    <RouterLink to="/plugins" class="mb-3 inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"><ArrowLeft class="size-4" aria-hidden="true" />插件列表</RouterLink>
    <div v-if="!status" class="rounded-lg border border-card-border bg-surface shadow-card"><QSkeleton :rows="3" label="正在读取插件" /></div>
    <QEmpty v-else-if="!plugin" :icon="SearchX" title="插件不存在" description="它可能已经卸载了。">
      <RouterLink to="/plugins" tabindex="-1"><QButton size="sm">回到插件列表</QButton></RouterLink>
    </QEmpty>
    <template v-else>
      <PageHeader :title="plugin.displayName" :description="plugin.description || undefined">
        <RouterLink v-if="plugin.ui && plugin.enabled" :to="`/plugin-ui/${plugin.name}`" tabindex="-1">
          <QButton size="sm"><PanelsTopLeft class="size-3.5" aria-hidden="true" />打开页面</QButton>
        </RouterLink>
        <div class="-mr-3 flex items-center gap-1">
          <span class="text-sm text-fg-muted">{{ plugin.enabled ? '已启用' : '已禁用' }}</span>
          <QSwitch :model-value="plugin.enabled" label="启用插件" :disabled="!!plugin.error" @update:model-value="toggle" />
        </div>
      </PageHeader>

      <p v-if="plugin.error" class="mb-4 rounded-lg bg-danger-bg px-4 py-3 font-mono text-xs break-words text-danger">加载失败：{{ plugin.error }}</p>

      <div class="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div class="flex min-w-0 flex-col gap-4">
          <PluginConfigCard :plugin="plugin" />
          <PluginRulesCard :plugin="plugin" />
        </div>
        <div class="flex min-w-0 flex-col gap-4">
          <QCard title="信息">
            <dl class="flex flex-col gap-2 text-sm">
              <div class="flex justify-between gap-3"><dt class="text-fg-muted">包名</dt><dd class="font-mono text-xs">{{ plugin.name }}</dd></div>
              <div class="flex justify-between gap-3"><dt class="text-fg-muted">版本</dt><dd class="font-mono text-xs">{{ plugin.version }}</dd></div>
              <div class="flex justify-between gap-3"><dt class="text-fg-muted">来源</dt><dd class="text-xs">{{ plugin.installed ? '面板安装' : '仓库内置' }}</dd></div>
              <div class="flex justify-between gap-3">
                <dt class="text-fg-muted">权限</dt>
                <dd class="flex flex-wrap justify-end gap-1">
                  <QBadge v-for="perm in plugin.permissions" :key="perm">{{ perm }}</QBadge>
                  <span v-if="!plugin.permissions.length" class="text-fg-subtle">无</span>
                </dd>
              </div>
            </dl>
          </QCard>
          <TriggerList :plugin="plugin" />
        </div>
      </div>

      <div class="mt-4"><UninstallCard :plugin="plugin" /></div>
    </template>
  </div>
</template>
