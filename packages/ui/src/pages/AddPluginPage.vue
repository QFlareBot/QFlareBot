<script setup lang="ts">
/** 添加插件：从插件市场挑，或粘贴仓库链接；两条路都先预检再装 */
import { ArrowLeft, Link, Store } from 'lucide-vue-next'
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import PageHeader from '../components/PageHeader.vue'
import MarketCatalog from '../components/plugins/MarketCatalog.vue'
import RepoInstall from '../components/plugins/RepoInstall.vue'
import QSegmented from '../components/ui/QSegmented.vue'
import { useQueryTab } from '../composables/useQueryTab.js'

const route = useRoute()
const tab = useQueryTab('tab', ['market', 'repo'] as const, 'market')
const initialSource = computed(() => (typeof route.query.source === 'string' ? route.query.source : undefined))
const TABS = [
  { value: 'market', label: '插件市场', icon: Store },
  { value: 'repo', label: '仓库链接', icon: Link },
]
</script>

<template>
  <div>
    <RouterLink to="/plugins" class="mb-3 inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"><ArrowLeft class="size-4" aria-hidden="true" />插件列表</RouterLink>
    <PageHeader title="添加插件" description="从插件目录挑，或粘贴插件仓库的链接。装之前都会先预检。" />
    <div class="mb-4"><QSegmented v-model="tab" :options="TABS" label="安装方式" /></div>
    <!-- 切走的标签留着：市场的搜索与勾选、仓库链接里填到一半的地址切回来都还在 -->
    <div role="tabpanel">
      <Transition name="tab" mode="out-in">
        <KeepAlive>
          <MarketCatalog v-if="tab === 'market'" />
          <RepoInstall v-else :initial-source="initialSource" />
        </KeepAlive>
      </Transition>
    </div>
  </div>
</template>
