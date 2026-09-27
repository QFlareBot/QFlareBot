<script setup lang="ts">
/** 构建记录：默认折叠，展开时拉取并顺带向 Cloudflare 同步构建状态 */
import { ChevronDown } from 'lucide-vue-next'
import type { InstallRecord } from '../../api/types.js'
import type { BuildState } from '../../composables/useBuildState.js'
import QBadge from '../ui/QBadge.vue'
import QButton from '../ui/QButton.vue'
import QCard from '../ui/QCard.vue'
import QCollapse from '../ui/QCollapse.vue'
import QEmpty from '../ui/QEmpty.vue'
import QSkeleton from '../ui/QSkeleton.vue'

defineProps<{ build: BuildState }>()

const STATUS: Record<InstallRecord['status'], { tone: 'neutral' | 'success' | 'warning' | 'danger'; label: string }> = {
  pending: { tone: 'neutral', label: '待构建' },
  building: { tone: 'warning', label: '构建中' },
  ok: { tone: 'success', label: '完成' },
  failed: { tone: 'danger', label: '失败' },
}
const ACTION: Record<InstallRecord['action'], string> = { install: '安装', upgrade: '升级', uninstall: '卸载', build: '构建' }

function formatTs(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <QCard flush :divider="build.buildsOpen.value" title="构建记录" description="安装、升级、卸载、构建都会记一笔，保留最近 100 条">
    <template #actions>
      <QButton size="sm" variant="ghost" :loading="build.rebuilding.value" @click="build.rebuild">重新构建</QButton>
      <QButton size="sm" variant="ghost" :aria-expanded="build.buildsOpen.value" @click="build.toggleBuilds">
        {{ build.buildsOpen.value ? '收起' : '展开' }}
        <ChevronDown class="size-3.5 transition-transform duration-(--qb-duration-slow)" :class="build.buildsOpen.value && 'rotate-180'" aria-hidden="true" />
      </QButton>
    </template>
    <QCollapse :open="build.buildsOpen.value">
      <p v-if="build.buildsFetchError.value" class="border-b border-border bg-danger-bg px-4 py-2 text-xs text-danger">{{ build.buildsFetchError.value }}</p>
      <p v-if="build.buildsSyncError.value" class="border-b border-border bg-warning-bg px-4 py-2 text-xs text-warning">
        构建状态同步失败：{{ build.buildsSyncError.value }}（请检查 CF_ACCOUNT_ID / CF_BUILDS_TOKEN / CF_WORKER_TAG，其中 WORKER_TAG 是 scripts 列表返回的 tag 而不是名字）
      </p>
      <QSkeleton v-if="!build.builds.value.length && build.buildsLoading.value" :rows="3" label="正在读取构建记录" />
      <QEmpty v-else-if="!build.builds.value.length" title="还没有记录" description="安装一个插件，或点「重新构建」触发一次。" />
      <ul v-else class="divide-y divide-border">
        <li v-for="b in build.builds.value" :key="b.id" class="flex items-center gap-3 px-4 py-2.5">
          <QBadge :tone="STATUS[b.status].tone">{{ STATUS[b.status].label }}</QBadge>
          <div class="min-w-0 flex-1">
            <p class="flex flex-wrap items-center gap-2 text-sm">
              <span class="font-medium text-fg">{{ ACTION[b.action] }}{{ b.name ? ` ${b.name}` : '' }}</span>
              <span v-if="b.commitHash" class="font-mono text-xs text-fg-subtle">{{ b.commitHash.slice(0, 7) }}</span>
            </p>
            <p class="truncate text-xs" :class="b.status === 'failed' && b.error ? 'text-danger' : 'text-fg-muted'">{{ b.error ?? b.source ?? '' }}</p>
          </div>
          <span class="shrink-0 text-xs text-fg-subtle tabular-nums">{{ formatTs(b.ts) }}</span>
        </li>
      </ul>
    </QCollapse>
  </QCard>
</template>
