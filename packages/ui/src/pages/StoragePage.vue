<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api } from '../api/client.js'
import type { StorageReport, StorageUsage } from '../api/types.js'
import PageHeader from '../components/PageHeader.vue'
import QBadge from '../components/ui/QBadge.vue'
import QButton from '../components/ui/QButton.vue'
import QCard from '../components/ui/QCard.vue'
import QEmpty from '../components/ui/QEmpty.vue'

const report = ref<StorageReport | null>(null)
const loading = ref(false)
const purging = ref<string | null>(null)

async function refresh() {
  loading.value = true
  try {
    report.value = await api.storage()
  } catch {
    report.value = null
  } finally {
    loading.value = false
  }
}
onMounted(() => void refresh())

async function purge(name: string) {
  if (purging.value) return
  if (!confirm(`彻底删除 ${name} 的全部数据？KV 键、D1 表和 R2 对象都会清掉，不可恢复。`)) return
  purging.value = name
  try {
    await api.purgeOrphan(name)
  } finally {
    purging.value = null
    void refresh()
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 三种存储的占用摘要；一项都没有就显示"没有数据" */
function summary(u: StorageUsage): string {
  const parts: string[] = []
  if (u.kvKeys) parts.push(`KV ${u.kvKeys} 个键`)
  if (u.tables.length) parts.push(`D1 ${u.tables.length} 张表 / ${u.tables.reduce((s, t) => s + t.rows, 0)} 行`)
  if (u.r2Objects) parts.push(`R2 ${u.r2Objects} 个对象 / ${formatBytes(u.r2Bytes)}`)
  return parts.join(' · ') || '没有数据'
}

const empty = computed(() => report.value && !report.value.plugins.length && !report.value.orphans.length)
</script>

<template>
  <div>
    <PageHeader
      title="存储"
      description="插件的数据按名字前缀归属框架管理。卸载默认保留数据，留下的会列在孤儿数据里，可以单独清掉。"
    />

    <QCard title="已装插件" description="每个插件占用的 KV 键、D1 表与行数、R2 对象">
      <template #actions>
        <QButton size="sm" variant="ghost" :loading="loading" @click="refresh">刷新</QButton>
      </template>
      <QEmpty
        v-if="!report"
        title="读不到存储信息"
        description="管理 API 未就绪或请求失败，点刷新重试。"
      />
      <QEmpty
        v-else-if="empty"
        title="还没有任何插件数据"
        description="插件往 ctx.kv / ctx.db / ctx.r2 写入后会出现在这里。"
      />
      <ul v-else-if="report.plugins.length" class="divide-y divide-border">
        <li v-for="u in report.plugins" :key="u.plugin" class="px-4 py-2.5">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-mono text-sm font-medium text-fg">{{ u.plugin }}</span>
          </div>
          <p class="text-xs text-fg-muted">{{ summary(u) }}</p>
          <p v-if="u.tables.length" class="mt-0.5 truncate font-mono text-xs text-fg-subtle">
            {{ u.tables.map((t) => `${t.name}(${t.rows})`).join('  ') }}
          </p>
        </li>
      </ul>
      <QEmpty v-else title="已装插件都没有写入数据" description="孤儿数据见下方。" />
    </QCard>

    <QCard
      v-if="report?.orphans.length"
      class="mt-4"
      title="孤儿数据"
      description="不属于任何已装插件——卸载时选了保留，或插件被手工移出清单"
    >
      <ul class="divide-y divide-border">
        <li v-for="u in report.orphans" :key="u.plugin" class="flex items-center gap-2 px-4 py-2.5">
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-mono text-sm font-medium text-fg">{{ u.plugin }}</span>
              <QBadge tone="warning">已卸载</QBadge>
            </div>
            <p class="text-xs text-fg-muted">{{ summary(u) }}</p>
          </div>
          <QButton size="sm" variant="danger" :loading="purging === u.plugin" @click="purge(u.plugin)">
            彻底删除
          </QButton>
        </li>
      </ul>
    </QCard>

    <QCard
      v-if="report?.unattributedTables.length"
      class="mt-4"
      title="对不上插件的表"
      description="表名带 p_ 前缀但匹配不到任何已知插件名（安装账本被清空后可能出现），只能用 wrangler d1 手工处置"
    >
      <p class="px-4 py-2.5 font-mono text-xs break-all text-fg-muted">{{ report.unattributedTables.join('  ') }}</p>
    </QCard>

    <p v-if="report && !report.bindings.d1" class="mt-4 text-xs text-fg-muted">未绑定 D1，表的用量无法统计。</p>
    <p v-if="report && !report.bindings.r2" class="mt-1 text-xs text-fg-muted">未绑定 R2，对象的用量无法统计。</p>
  </div>
</template>
