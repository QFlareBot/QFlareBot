<script setup lang="ts">
import { ExternalLink } from 'lucide-vue-next'
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ApiError, DEPENDENCIES_MISSING, api } from '../api/client.js'
import type { InstallPreview, ManagedPluginsResult } from '../api/types.js'
import PageHeader from '../components/PageHeader.vue'
import QBadge from '../components/ui/QBadge.vue'
import QButton from '../components/ui/QButton.vue'
import QCard from '../components/ui/QCard.vue'
import QEmpty from '../components/ui/QEmpty.vue'
import QInput from '../components/ui/QInput.vue'
import { useStatus } from '../composables/useStatus.js'
import { useToast } from '../composables/useToast.js'
import {
  CATALOG_INDEX_URL,
  batchItemOf,
  dependsCoveredByBatch,
  fetchCatalog,
  installOrder,
  installUrlOf,
  type CatalogPlugin,
} from '../lib/catalog.js'
import { eachLimit, resolveSource } from '../lib/gitSource.js'

const { plugins, refresh } = useStatus()
const { push } = useToast()
const route = useRoute()
const router = useRouter()

// —— 目录与已装插件 ——

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

function repoOfSource(source: string | null): string | null {
  return source ? (/^git:([^@]+)@/.exec(source)?.[1] ?? null) : null
}

/** 装着同名插件、但来源不是目录里这个仓库（也可能只是仓库改过名） */
function installedElsewhere(p: CatalogPlugin): string | null {
  const repo = repoOfSource(installed.value.get(p.name)?.source ?? null)
  return repo && repo.toLowerCase() !== p.repo.toLowerCase() ? repo : null
}

// —— 筛选 ——

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
      return [p.name, p.displayName, p.description, p.author, ...(p.tags ?? []), ...(p.commands ?? []).map((c) => c.name)].some((s) =>
        s?.toLowerCase().includes(q),
      )
    })
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.name.localeCompare(b.name))
})

function toggleSelected(name: string, on: boolean) {
  if (on) selected.value.add(name)
  else selected.value.delete(name)
}

function formatDate(iso?: string | null): string {
  return iso ? new Date(iso).toLocaleDateString('zh-CN') : ''
}

// —— 预检：逐个解析最新 commit 并 dryRun，什么都不写 ——

interface PreviewRow {
  plugin: CatalogPlugin
  source: string | null
  preview: InstallPreview | null
  /** 装不了的原因；有它就不装 */
  error: string | null
  /** 依赖由同一批里排在前面的插件提供：预检不写 D1，所以现在看不到，按顺序装就能过 */
  waitsForBatch: boolean
  notice: string | null
  /** 声明了 DO 的：确认已往仓库补好 migrations 才装 */
  ackDo: boolean
}

const rows = ref<PreviewRow[] | null>(null)
const previewing = ref(false)
const installing = ref(false)

function installable(r: PreviewRow): boolean {
  if (r.error || !r.source) return false
  if (r.waitsForBatch) return true
  return !!r.preview && (!r.preview.durableObjects || r.ackDo)
}

const installableRows = computed(() => (rows.value ?? []).filter(installable))

async function startPreview(names: string[]) {
  const picked = catalog.value.filter((p) => names.includes(p.name))
  if (!picked.length || previewing.value || installing.value) return
  previewing.value = true
  const batch = picked.map(batchItemOf)
  const ordered = installOrder(
    picked.map((p) => ({ ...batchItemOf(p), plugin: p })),
    available.value,
  )
  const out: PreviewRow[] = ordered.map(({ plugin }) => ({
    plugin,
    source: null,
    preview: null,
    error: null,
    waitsForBatch: false,
    notice: null,
    ackDo: false,
  }))
  await eachLimit(out, 4, async (row) => {
    try {
      const { source, notice } = await resolveSource(installUrlOf(row.plugin))
      row.source = source
      row.notice = notice ?? null
      row.preview = await api.previewInstall(source)
    } catch (e) {
      const coveredByBatch =
        e instanceof ApiError && e.code === DEPENDENCIES_MISSING && dependsCoveredByBatch(batchItemOf(row.plugin), batch, available.value)
      if (coveredByBatch && !row.plugin.durableObjects?.length) row.waitsForBatch = true
      else if (coveredByBatch) row.error = `${(e as Error).message}；它还声明了 Durable Object，请单独安装`
      else row.error = (e as Error).message
    }
  })
  rows.value = out
  previewing.value = false
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

/** 单个安装走同一套：只选它，预检后确认 */
function installOne(p: CatalogPlugin) {
  selected.value = new Set([p.name])
  void startPreview([p.name])
}

function cancelPreview() {
  rows.value = null
}

/** 按依赖顺序逐个写进清单（build: false），全部写完只触发一次构建 */
async function confirmInstall() {
  const list = installableRows.value
  if (!list.length || installing.value) return
  installing.value = true
  const done: string[] = []
  const failed: string[] = []
  const warnings: string[] = []
  for (const row of list) {
    try {
      const res = await api.installPlugin(row.source!, { build: false, acknowledgeDurableObjects: !!row.preview?.durableObjects && row.ackDo })
      done.push(row.plugin.name)
      for (const w of res.warnings ?? []) warnings.push(`${row.plugin.name}：${w}`)
    } catch (e) {
      failed.push(`${row.plugin.name}：${(e as Error).message}`)
    }
  }
  if (done.length) {
    try {
      await api.triggerBuild()
      push(`已安装 ${done.join('、')}，只触发了一次构建，上线后出现在插件列表里`, 'success')
    } catch (e) {
      push(`${done.length} 个插件已写进清单，但触发构建失败：${(e as Error).message}——可在插件页「未上线的改动」里重新构建`, 'warning')
    }
  }
  if (failed.length) push(`有 ${failed.length} 个没装上：${failed.join('；')}`, 'error')
  if (warnings.length) push(`提醒：${warnings.join('；')}`, 'warning')
  installing.value = false
  if (done.length) {
    rows.value = null
    selected.value.clear()
    void refresh()
    await router.push('/plugins')
  }
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
  void router.replace({ query: {} })
  const known = wanted.filter((n) => catalog.value.some((p) => p.name === n) && !installed.value.has(n))
  const skipped = wanted.filter((n) => !known.includes(n))
  if (skipped.length) push(`${skipped.join('、')} 不在目录里或已经装了，跳过`, 'warning')
  for (const n of known) selected.value.add(n)
  if (known.length) await startPreview(known)
})
</script>

<template>
  <div>
    <PageHeader title="插件市场" description="插件目录里登记的插件。勾选几个一起装，只构建一次；装之前会逐个预检。" />

    <QCard v-if="rows" class="mb-4" title="安装预检" description="确认后按依赖顺序写进插件清单，全部写完只触发一次构建">
      <template #actions>
        <QButton size="sm" variant="ghost" :disabled="installing" @click="cancelPreview">取消</QButton>
        <QButton size="sm" variant="primary" :loading="installing" :disabled="!installableRows.length" @click="confirmInstall">
          确认安装 {{ installableRows.length }} 个，构建一次
        </QButton>
      </template>
      <ul class="flex flex-col gap-3">
        <li v-for="row in rows" :key="row.plugin.name" class="rounded-md border border-border p-3">
          <div class="flex flex-wrap items-center gap-2 text-sm">
            <span class="font-medium text-fg">{{ row.plugin.displayName ?? row.plugin.name }}</span>
            <span class="font-mono text-xs text-fg-subtle">{{ row.plugin.name }}@{{ row.preview?.plugin.version ?? row.plugin.version }}</span>
            <QBadge v-if="row.error" tone="danger">装不了</QBadge>
            <QBadge v-else-if="row.waitsForBatch" tone="neutral">依赖本批插件</QBadge>
            <QBadge v-else-if="row.preview?.previous" tone="neutral">升级自 {{ row.preview.previous.version }}</QBadge>
          </div>
          <p v-if="row.error" class="mt-1 whitespace-pre-wrap break-words text-xs text-danger">{{ row.error }}</p>
          <template v-else>
            <dl class="mt-2 flex flex-col gap-1.5 text-xs">
              <div class="flex flex-wrap items-center gap-1">
                <dt class="mr-1 text-fg-muted">权限</dt>
                <dd class="flex flex-wrap gap-1">
                  <QBadge v-for="perm in row.preview?.manifest.permissions ?? row.plugin.permissions ?? []" :key="perm">{{ perm }}</QBadge>
                  <span v-if="!(row.preview?.manifest.permissions ?? row.plugin.permissions ?? []).length" class="text-fg-subtle">无</span>
                </dd>
              </div>
              <div v-if="row.preview && Object.keys(row.preview.dependencies ?? {}).length" class="flex flex-wrap items-center gap-1">
                <dt class="mr-1 text-fg-muted">第三方依赖</dt>
                <dd class="flex flex-wrap gap-1">
                  <QBadge v-for="(range, pkg) in row.preview.dependencies" :key="pkg"><span class="font-mono">{{ pkg }} {{ range }}</span></QBadge>
                </dd>
              </div>
            </dl>
            <p v-if="row.waitsForBatch" class="mt-2 text-xs text-fg-muted">
              它依赖的服务（{{ (row.plugin.depends ?? []).join('、') }}）由这一批里排在前面的插件提供，按顺序写进清单时会通过校验。
            </p>
            <ul
              v-if="row.preview?.warnings.length || row.notice"
              class="mt-2 flex flex-col gap-1 rounded-md border border-warning/30 bg-warning/10 p-2 text-xs text-warning"
            >
              <li v-for="w in row.preview?.warnings ?? []" :key="w">{{ w }}</li>
              <li v-if="row.notice">{{ row.notice }}</li>
            </ul>
            <template v-if="row.preview?.durableObjects">
              <pre class="mt-2 whitespace-pre-wrap rounded-md border border-warning/30 bg-warning/10 p-2 font-mono text-xs text-warning">{{ row.preview.durableObjects.message }}</pre>
              <label class="mt-2 flex cursor-pointer items-center gap-2 text-xs text-fg">
                <input v-model="row.ackDo" type="checkbox" class="size-4" />
                已往仓库补好 migrations 并推送（不勾就不装它）
              </label>
            </template>
          </template>
        </li>
      </ul>
    </QCard>

    <QCard flush title="目录" description="来自 QFlareBot/plugins；只检查能构建、名字不冲突，不是安全审核">
      <template #actions>
        <QButton
          size="sm"
          variant="primary"
          :loading="previewing"
          :disabled="!selected.size || installing || !!rows"
          @click="startPreview([...selected])"
        >
          预检选中（{{ selected.size }}）
        </QButton>
      </template>

      <div class="flex flex-col gap-2 border-b border-border px-4 py-3">
        <QInput v-model="query" type="search" placeholder="搜索名称、描述、作者、命令" />
        <div v-if="tags.length" class="flex flex-wrap gap-1.5" role="group" aria-label="按标签筛选">
          <button
            v-for="t in [null, ...tags]"
            :key="t ?? '全部'"
            type="button"
            class="h-7 cursor-pointer rounded-full border px-2.5 text-xs"
            :class="activeTag === t ? 'border-accent bg-accent text-on-accent' : 'border-border text-fg-muted hover:text-fg'"
            @click="activeTag = activeTag === t ? null : t"
          >
            {{ t ?? '全部' }}
          </button>
        </div>
      </div>

      <p v-if="loadState === 'loading'" class="px-4 py-6 text-sm text-fg-muted">正在读取插件目录…</p>
      <QEmpty v-else-if="loadState === 'error'" title="读不到插件目录" :description="`${loadError}。目录地址：${CATALOG_INDEX_URL}`" />
      <QEmpty v-else-if="!shown.length" title="没有符合条件的插件" description="换个关键词或标签试试。" />
      <ul v-else class="divide-y divide-border">
        <li v-for="p in shown" :key="p.name" class="flex items-start gap-3 px-4 py-3">
          <input
            type="checkbox"
            class="mt-1 size-4 shrink-0"
            :checked="selected.has(p.name)"
            :disabled="installed.has(p.name) || previewing || installing || !!rows"
            :aria-label="`选中 ${p.displayName ?? p.name}`"
            @change="toggleSelected(p.name, ($event.target as HTMLInputElement).checked)"
          />
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-sm font-medium text-fg">{{ p.displayName ?? p.name }}</span>
              <span class="font-mono text-xs text-fg-subtle">{{ p.name }}{{ p.version ? `@${p.version}` : '' }}</span>
              <QBadge v-if="installed.get(p.name)?.pending" tone="warning">待上线</QBadge>
              <QBadge v-else-if="installed.has(p.name)" tone="success">已安装</QBadge>
              <QBadge v-if="p.status === 'error'" tone="warning">目录最近没读到</QBadge>
              <QBadge v-for="t in p.tags ?? []" :key="t">{{ t }}</QBadge>
            </div>
            <p v-if="p.description" class="mt-0.5 text-xs text-fg-muted">{{ p.description }}</p>
            <p class="mt-0.5 text-xs text-fg-subtle">
              {{ [p.author, p.stars !== undefined ? `★ ${p.stars}` : '', p.license ?? '', p.updatedAt ? `${formatDate(p.updatedAt)} 更新` : '', p.permissions?.length ? `权限：${p.permissions.join('、')}` : ''].filter(Boolean).join(' · ') }}
            </p>
            <p v-if="installedElsewhere(p)" class="mt-0.5 text-xs text-fg-subtle">已装的这份来自 {{ installedElsewhere(p) }}</p>
            <p v-if="p.status === 'error' && p.error" class="mt-0.5 text-xs text-warning">{{ p.error }}</p>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <QButton
              v-if="!installed.has(p.name)"
              size="sm"
              :loading="previewing && selected.size === 1 && selected.has(p.name)"
              :disabled="previewing || installing || !!rows"
              @click="installOne(p)"
            >
              安装
            </QButton>
            <a
              :href="`https://github.com/${p.repo}`"
              target="_blank"
              rel="noopener"
              class="flex size-7 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-muted hover:text-fg"
              :aria-label="`${p.displayName ?? p.name} 的仓库`"
            >
              <ExternalLink class="size-4" aria-hidden="true" />
            </a>
          </div>
        </li>
      </ul>
    </QCard>
  </div>
</template>
