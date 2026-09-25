<script setup lang="ts">
import { Copy, RefreshCw, Trash2 } from 'lucide-vue-next'
import { computed, onMounted, ref } from 'vue'
import { api } from '../api/client.js'
import type { EventRecord, MatchRecord } from '../api/types.js'
import PageHeader from '../components/PageHeader.vue'
import QBadge from '../components/ui/QBadge.vue'
import QButton from '../components/ui/QButton.vue'
import QCard from '../components/ui/QCard.vue'
import QEmpty from '../components/ui/QEmpty.vue'
import StatusDot from '../components/ui/StatusDot.vue'
import { useStatus } from '../composables/useStatus.js'
import { useToast } from '../composables/useToast.js'

const { status, plugins, refresh, updatedAt, loading } = useStatus({ pollMs: 5000 })
const { push } = useToast()
const events = ref<EventRecord[]>([])

async function loadEvents() {
  try {
    events.value = (await api.events(20)).events
  } catch (e) {
    push(`读取事件失败：${(e as Error).message}`, 'error')
  }
}
onMounted(loadEvents)
setInterval(() => document.visibilityState === 'visible' && void loadEvents(), 5000)

const clearing = ref(false)
async function clear() {
  if (!confirm('清空全部事件记录？这只删 D1 里的分发摘要，不影响消息收发。')) return
  clearing.value = true
  try {
    await api.clearEvents()
    await loadEvents()
    push('事件记录已清空', 'success')
  } catch (e) {
    push(`清空失败：${(e as Error).message}`, 'error')
  } finally {
    clearing.value = false
  }
}

const enabledCount = computed(() => plugins.value.filter((p) => p.enabled).length)
const brokenCount = computed(() => plugins.value.filter((p) => p.error).length)
const webhookUrl = computed(() => `${location.origin}${status.value?.webhookPath ?? '/webhook'}`)
/** QQ 开放平台访问不到 *.workers.dev：从默认域名打开面板时，这里显示的地址填了也不通 */
const onWorkersDev = location.hostname.endsWith('.workers.dev')
const ago = computed(() => (updatedAt.value ? `${Math.max(0, Math.round((Date.now() - updatedAt.value) / 1000))} 秒前` : ''))

function copyWebhook() {
  void navigator.clipboard.writeText(webhookUrl.value).then(() => push('已复制回调地址', 'success'))
}
function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
}
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
const sceneLabel: Record<string, string> = { group: '群聊', c2c: '单聊', guild: '频道', guild_dm: '频道私信', unknown: '—' }
</script>

<template>
  <div>
    <PageHeader title="概览" :description="ago ? `更新于 ${ago}` : undefined">
      <QButton size="sm" :loading="loading" @click="refresh(); loadEvents()"><RefreshCw class="size-3.5" aria-hidden="true" />刷新</QButton>
    </PageHeader>

    <QCard v-if="status && !status.bot" title="尚未配置机器人" description="填写 AppID 与 AppSecret 后，机器人才能验签和发消息。" class="mb-4">
      <RouterLink to="/settings"><QButton variant="primary" size="sm">前往设置</QButton></RouterLink>
    </QCard>

    <div class="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
      <QCard>
        <p class="text-xs text-fg-muted">机器人</p>
        <div class="mt-1"><StatusDot v-if="status?.bot" tone="success" :label="status.bot.appId" /><StatusDot v-else tone="warning" label="未配置" /></div>
      </QCard>
      <QCard>
        <p class="text-xs text-fg-muted">插件</p>
        <p class="mt-1 text-lg font-semibold tabular-nums text-fg">{{ enabledCount }}<span class="text-sm font-normal text-fg-muted"> / {{ plugins.length }} 启用</span></p>
        <p v-if="brokenCount" class="text-xs text-danger">{{ brokenCount }} 个加载失败</p>
      </QCard>
      <QCard>
        <p class="text-xs text-fg-muted">24 小时事件</p>
        <p class="mt-1 text-lg font-semibold tabular-nums text-fg">{{ status?.stats?.last24h ?? '—' }}</p>
      </QCard>
      <QCard>
        <p class="text-xs text-fg-muted">24 小时错误</p>
        <p class="mt-1 text-lg font-semibold tabular-nums" :class="status?.stats?.errors24h ? 'text-danger' : 'text-fg'">{{ status?.stats?.errors24h ?? '—' }}</p>
      </QCard>
    </div>

    <QCard title="回调地址" description="填到 QQ 开放平台 → 开发设置 → 回调配置" class="mb-4">
      <p v-if="onWorkersDev" class="text-sm text-fg">
        QQ 开放平台访问不到 <code class="font-mono text-xs">*.workers.dev</code>，回调必须走自定义域名：先到 Cloudflare 后台给这个 Worker 的
        Settings → Domains &amp; Routes 添加一个 Custom Domain，再用新域名打开面板，这里就会显示可以填的回调地址。
      </p>
      <div v-else class="flex flex-wrap items-center gap-2">
        <code class="min-w-0 flex-1 truncate rounded-md bg-surface-muted px-2 py-1.5 font-mono text-xs text-fg">{{ webhookUrl }}</code>
        <QButton size="sm" @click="copyWebhook"><Copy class="size-3.5" aria-hidden="true" />复制</QButton>
      </div>
      <dl class="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs md:grid-cols-4">
        <div><dt class="text-fg-muted">运行时</dt><dd class="font-mono text-fg">{{ status?.runtime ?? '—' }}</dd></div>
        <div><dt class="text-fg-muted">投影</dt><dd class="truncate font-mono text-fg" :title="status?.projection ?? ''">{{ status?.projection?.slice(7, 19) ?? '静态入口' }}</dd></div>
        <div><dt class="text-fg-muted">快照版本</dt><dd class="font-mono text-fg">{{ status?.snapshot.revision ?? '—' }}</dd></div>
        <div><dt class="text-fg-muted">安全模式</dt><dd class="text-fg">{{ status?.snapshot.safeMode ? '开（插件全部跳过）' : '关' }}</dd></div>
      </dl>
    </QCard>

    <QCard title="最近事件" description="每个事件一行分发摘要" flush>
      <template v-if="events.length" #actions>
        <QButton size="sm" variant="ghost" :loading="clearing" @click="clear">
          <Trash2 class="size-3.5" aria-hidden="true" />清空
        </QButton>
      </template>
      <QEmpty v-if="status && !status.bindings.d1" title="未绑定 D1，事件记录已关闭" description="在 wrangler.jsonc 的 d1_databases 加一条绑定并重新部署即可开启；不影响消息收发。" />
      <!-- 只有真实 webhook 会写记录，「调试」页的模拟是干跑，不要在这里引导过去 -->
      <QEmpty v-else-if="!events.length" title="还没有事件" description="机器人收到真实消息后会出现在这里。「调试」页的模拟事件是干跑，不计入记录。" />
      <div v-else class="overflow-x-auto">
        <table class="qb-table">
          <thead><tr><th>时间</th><th>事件</th><th>场景</th><th>内容</th><th>命中</th><th>结果</th></tr></thead>
          <tbody>
            <tr v-for="e in events" :key="e.id">
              <td class="font-mono text-xs text-fg-muted">{{ fmtTime(e.ts) }}</td>
              <td class="font-mono text-xs">{{ e.event.replace(/^qq\./, '') }}</td>
              <td class="text-fg-muted">{{ sceneLabel[e.scene] ?? e.scene }}</td>
              <td class="max-w-64 truncate" :title="e.content">{{ e.content || '—' }}</td>
              <td>
                <span class="flex flex-wrap gap-1">
                  <QBadge v-for="m in matched(e)" :key="m.plugin + m.name" tone="neutral">{{ m.plugin }}<span class="text-fg-subtle">/{{ m.name }}</span></QBadge>
                  <span v-if="!matched(e).length" class="text-xs text-fg-subtle">无</span>
                </span>
              </td>
              <td>
                <StatusDot v-if="errorCount(e)" tone="danger" :label="`${errorCount(e)} 个错误`" />
                <StatusDot v-else-if="e.failed" tone="danger" :label="`发送失败 ${e.failed} 条`" />
                <StatusDot v-else-if="e.outbox" tone="success" :label="`回复 ${e.outbox} 条`" />
                <StatusDot v-else tone="neutral" label="无回复" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </QCard>
  </div>
</template>
