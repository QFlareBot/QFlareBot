<script setup lang="ts">
/** 最近事件：桌面是表格，手机是一条一张的卡片（表格在窄屏上要横向滚，看不全） */
import type { EventRecord, MatchRecord } from '../api/types.js'
import QBadge from './ui/QBadge.vue'
import StatusDot from './ui/StatusDot.vue'

defineProps<{ events: EventRecord[]; showContent: boolean }>()

function matched(e: EventRecord): MatchRecord[] {
  try {
    return JSON.parse(e.matched) as MatchRecord[]
  } catch {
    return []
  }
}
function errorCount(e: EventRecord): number {
  try {
    return (JSON.parse(e.errors) as unknown[]).length
  } catch {
    return 0
  }
}
function outcome(e: EventRecord): { tone: 'success' | 'danger' | 'neutral'; label: string } {
  const errors = errorCount(e)
  if (errors) return { tone: 'danger', label: `${errors} 个错误` }
  if (e.failed) return { tone: 'danger', label: `发送失败 ${e.failed} 条` }
  if (e.outbox) return { tone: 'success', label: `回复 ${e.outbox} 条` }
  return { tone: 'neutral', label: '无回复' }
}
const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
const SCENE: Record<string, string> = { group: '群聊', c2c: '单聊', guild: '频道', guild_dm: '频道私信', unknown: '—' }
const eventName = (e: EventRecord) => e.event.replace(/^qq\./, '')
</script>

<template>
  <!-- 手机：卡片列表 -->
  <TransitionGroup tag="ul" name="row" class="divide-y divide-border md:hidden">
    <li v-for="e in events" :key="e.id" class="flex flex-col gap-1.5 px-4 py-3">
      <div class="flex items-center justify-between gap-3">
        <span class="font-mono text-xs text-fg">{{ eventName(e) }}</span>
        <span class="shrink-0 font-mono text-xs text-fg-subtle">{{ fmtTime(e.ts) }}</span>
      </div>
      <p v-if="showContent && e.content" class="truncate text-sm text-fg">{{ e.content }}</p>
      <div class="flex flex-wrap items-center gap-1.5 text-xs">
        <span class="text-fg-muted">{{ SCENE[e.scene] ?? (e.scene || '—') }}</span>
        <QBadge v-for="m in matched(e)" :key="m.plugin + m.name">{{ m.plugin }}<span class="text-fg-subtle">/{{ m.name }}</span></QBadge>
        <StatusDot :tone="outcome(e).tone" :label="outcome(e).label" class="ml-auto text-xs" />
      </div>
    </li>
  </TransitionGroup>

  <!-- 桌面：表格 -->
  <div class="hidden overflow-x-auto md:block">
    <table class="qb-table">
      <thead>
        <tr><th>时间</th><th>事件</th><th>场景</th><th v-if="showContent">内容</th><th>命中</th><th>结果</th></tr>
      </thead>
      <!-- 轮询拉到的新事件淡入并短暂高亮；首屏不做（TransitionGroup 默认不对初次渲染动画） -->
      <TransitionGroup tag="tbody" name="row">
        <tr v-for="e in events" :key="e.id">
          <td class="font-mono text-xs text-fg-muted">{{ fmtTime(e.ts) }}</td>
          <td class="font-mono text-xs">{{ eventName(e) }}</td>
          <td class="text-fg-muted">{{ SCENE[e.scene] ?? (e.scene || '—') }}</td>
          <td v-if="showContent" class="max-w-64 truncate" :title="e.content">{{ e.content || '—' }}</td>
          <td>
            <span class="flex flex-wrap gap-1">
              <QBadge v-for="m in matched(e)" :key="m.plugin + m.name">{{ m.plugin }}<span class="text-fg-subtle">/{{ m.name }}</span></QBadge>
              <span v-if="!matched(e).length" class="text-xs text-fg-subtle">无</span>
            </span>
          </td>
          <td><StatusDot :tone="outcome(e).tone" :label="outcome(e).label" /></td>
        </tr>
      </TransitionGroup>
    </table>
  </div>
</template>
