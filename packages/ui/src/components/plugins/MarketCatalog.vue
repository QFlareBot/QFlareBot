<script setup lang="ts">
/** 插件市场：读插件目录的 index.json，搜索、按标签筛；勾选几个一起装，只构建一次 */
import { PackageSearch } from 'lucide-vue-next'
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../../api/client.js'
import type { ManagedPluginsResult } from '../../api/types.js'
import { useCatalogInstall } from '../../composables/useCatalogInstall.js'
import { useStatus } from '../../composables/useStatus.js'
import { useToast } from '../../composables/useToast.js'
import { CATALOG_INDEX_URL, fetchCatalog, type CatalogPlugin } from '../../lib/catalog.js'
import QButton from '../ui/QButton.vue'
import QCard from '../ui/QCard.vue'
import QEmpty from '../ui/QEmpty.vue'
import QInput from '../ui/QInput.vue'
import QSkeleton from '../ui/QSkeleton.vue'
import CatalogItem from './CatalogItem.vue'
import CatalogPreviewDialog from './CatalogPreviewDialog.vue'

const { plugins } = useStatus()
const { push } = useToast()
const route = useRoute()
const router = useRouter()

const catalog = ref<CatalogPlugin[]>([])
const loadState = ref<'loading' | 'ready' | 'error'>('loading')
const loadError = ref('')
const managed = ref<ManagedPluginsResult | null>(null)

/** 已装的（线上在跑的，加上写进清单、还没上线的）：name → 来源 */
const installed = computed(() => {
  const map = new Map<string, { source: string | null; pending: boolean }>()
  for (const p of plugins.value) map.set(p.name, { source: p.origin?.source ?? null, pending: false })
  for (const m of managed.value?.plugins ?? []) if (!map.has(m.name)) map.set(m.name, { source: m.source, pending: true })
  return map
})
/** 已经有人提供的服务：批量安装排顺序、判断依赖时用 */
const available = computed(() => new Set(plugins.value.flatMap((p) => [p.name, ...p.services])))
const install = useCatalogInstall(available)

/** 装着同名插件、但来源不是目录里这个仓库（也可能只是仓库改过名） */
function installedFrom(p: CatalogPlugin): string | null {
  const source = installed.value.get(p.name)?.source ?? null
  const repo = source ? (/^git:([^@]+)@/.exec(source)?.[1] ?? null) : null
  return repo && repo.toLowerCase() !== p.repo.toLowerCase() ? repo : null
}

// —— 筛选与勾选 ——
const query = ref('')
const activeTag = ref<string | null>(null)
const selected = ref(new Set<string>())

const tags = computed(() => {
  const counts = new Map<string, number>()
  for (const p of catalog.value) for (const t of p.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh')).map(([t]) => t)
})

const shown = computed(() => {
  const q = query.value.trim().toLowerCase()
  return catalog.value
    .filter((p) => {
      if (activeTag.value && !(p.tags ?? []).includes(activeTag.value)) return false
      if (!q) return true
      return [p.name, p.displayName, p.description, p.author, ...(p.tags ?? []), ...(p.commands ?? []).map((c) => c.name)].some((s) => s?.toLowerCase().includes(q))
    })
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.name.localeCompare(b.name))
})

const busy = computed(() => install.previewing.value || install.installing.value || !!install.rows.value)

function toggleSelected(name: string, on: boolean) {
  if (on) selected.value.add(name)
  else selected.value.delete(name)
}
function previewSelected() {
  void install.startPreview(catalog.value.filter((p) => selected.value.has(p.name)))
}
/** 单个安装走同一套：只选它，预检后确认 */
function installOne(p: CatalogPlugin) {
  selected.value = new Set([p.name])
  void install.startPreview([p])
}

// —— 加载；文档站「在我的机器人上安装」跳过来时带 ?install=a,b ——
onMounted(async () => {
  void api
    .managedPlugins()
    .then((m) => (managed.value = m))
    .catch(() => (managed.value = null))
  try {
    catalog.value = await fetchCatalog()
    loadState.value = 'ready'
  } catch (e) {
    loadError.value = (e as Error).message
    loadState.value = 'error'
    return
  }
  const wanted = String(route.query.install ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!wanted.length) return
  // 清掉参数：刷新页面不再自动预检一遍
  void router.replace({ query: { ...route.query, install: undefined } })
  const known = wanted.filter((n) => catalog.value.some((p) => p.name === n) && !installed.value.has(n))
  const skipped = wanted.filter((n) => !known.includes(n))
  if (skipped.length) push(`${skipped.join('、')} 不在目录里或已经装了，跳过`, 'warning')
  for (const n of known) selected.value.add(n)
  if (known.length) previewSelected()
})
</script>

<template>
  <QCard flush title="插件目录" description="来自 QFlareBot/plugins。只检查能构建、名字不冲突，不是安全审核">
    <template #actions>
      <QButton size="sm" variant="primary" :loading="install.previewing.value" :disabled="!selected.size || busy" @click="previewSelected">
        预检选中（{{ selected.size }}）
      </QButton>
    </template>

    <div class="flex flex-col gap-2.5 border-b border-border px-4 py-3">
      <QInput v-model="query" type="search" placeholder="搜索名称、描述、作者、命令" aria-label="搜索插件" />
      <div v-if="tags.length" class="flex flex-wrap gap-1.5" role="group" aria-label="按标签筛选">
        <button
          v-for="t in [null, ...tags]"
          :key="t ?? '全部'"
          type="button"
          class="h-7 cursor-pointer rounded-full border px-3 text-xs transition-[background-color,border-color,color,transform] duration-(--qb-duration) active:scale-95"
          :class="activeTag === t ? 'border-transparent bg-primary font-medium text-on-primary' : 'border-border-strong text-fg-muted hover:bg-surface-muted hover:text-fg'"
          :aria-pressed="activeTag === t"
          @click="activeTag = activeTag === t ? null : t"
        >
          {{ t ?? '全部' }}
        </button>
      </div>
    </div>

    <QSkeleton v-if="loadState === 'loading'" :rows="4" label="正在读取插件目录" />
    <QEmpty v-else-if="loadState === 'error'" :icon="PackageSearch" title="读不到插件目录" :description="`${loadError}。目录地址：${CATALOG_INDEX_URL}`" />
    <QEmpty v-else-if="!shown.length" :icon="PackageSearch" title="没有符合条件的插件" description="换个关键词或标签试试。" />
    <ul v-else class="divide-y divide-border">
      <CatalogItem
        v-for="p in shown"
        :key="p.name"
        :plugin="p"
        :installed="installed.get(p.name)"
        :installed-from="installedFrom(p)"
        :selected="selected.has(p.name)"
        :disabled="busy"
        :loading="install.previewing.value && selected.size === 1 && selected.has(p.name)"
        @select="toggleSelected(p.name, $event)"
        @install="installOne(p)"
      />
    </ul>
  </QCard>

  <CatalogPreviewDialog
    :rows="install.rows.value"
    :installing="install.installing.value"
    :installable-count="install.installableRows.value.length"
    @cancel="install.cancel"
    @confirm="install.confirm"
  />
</template>
