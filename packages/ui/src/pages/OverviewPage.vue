<script setup lang="ts">
import { Copy, Radio, RefreshCw, Square, Trash2 } from 'lucide-vue-next'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { api } from '../api/client.js'
import type { EventRecord, LogsResult, MatchRecord } from '../api/types.js'
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

/**
 * 最近事件有两个来源：
 * - 平时：Workers Logs 里的分发摘要（约 15 秒延迟、不带正文），D1 一行不写；
 * - 实时调试：开着时事件连同正文写进 D1（最多 50 条），页面每 30 秒续一次期。
 *   关掉开关、离开页面、切到后台都会停；没来得及说停的（断网、崩溃），60 秒后服务端自己停。
 */
const logs = ref<LogsResult | null>(null)
const liveEvents = ref<EventRecord[]>([])
const live = ref(false)
const liveBusy = ref(false)
/** 切到后台时临时停掉，回到前台自动接着开 */
let livePaused = false
const events = computed(() => (live.value ? liveEvents.value : (logs.value?.events ?? [])))

/** 日志本身有约 15 秒延迟，一次查询又要好几秒，拉得再勤也不会更新 */
const LOG_POLL_MS = 30_000
const LIVE_POLL_MS = 3_000
const LIVE_RENEW_MS = 30_000
const visible = () => document.visibilityState === 'visible'

const logsLoading = ref(false)
async function loadLogs() {
  if (logsLoading.value) return
  logsLoading.value = true
  try {
    logs.value = await api.logs(20)
  } catch (e) {
    push(`读取事件失败：${(e as Error).message}`, 'error')
  } finally {
    logsLoading.value = false
  }
}
async function loadLive() {
  try {
    liveEvents.value = (await api.events(50)).events
  } catch (e) {
    push(`读取实时调试记录失败：${(e as Error).message}`, 'error')
  }
}
function loadEvents() {
  return live.value ? loadLive() : loadLogs()
}

async function startLive() {
  liveBusy.value = true
  try {
    await api.live(true)
    live.value = true
    await loadLive()
  } catch (e) {
    push(`开启实时调试失败：${(e as Error).message}`, 'error')
  } finally {
    liveBusy.value = false
  }
}
async function stopLive() {
  live.value = false
  livePaused = false
  await api.live(false).catch(() => {})
  await loadLogs()
}

function onVisibility() {
  if (!live.value) return
  if (!visible()) {
    livePaused = true
    void api.live(false, true).catch(() => {})
  } else if (livePaused) {
    livePaused = false
    void api.live(true).then(loadLive, () => {})
  }
}
function onPageHide() {
  if (live.value) void api.live(false, true).catch(() => {})
}

const timers: ReturnType<typeof setInterval>[] = []
onMounted(() => {
  void loadLogs()
  timers.push(
    setInterval(() => visible() && !live.value && void loadLogs(), LOG_POLL_MS),
    setInterval(() => visible() && live.value && void loadLive(), LIVE_POLL_MS),
    setInterval(() => visible() && live.value && void api.live(true).catch(() => {}), LIVE_RENEW_MS),
  )
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', onPageHide)
})
onUnmounted(() => {
  for (const t of timers) clearInterval(t)
  document.removeEventListener('visibilitychange', onVisibility)
  window.removeEventListener('pagehide', onPageHide)
  if (live.value) void api.live(false).catch(() => {})
})

const clearing = ref(false)
async function clear() {
  if (!confirm('清空实时调试记下的事件？这只删 D1 里的这几十条，Workers Logs 里的日志不受影响。')) return
  clearing.value = true
  try {
    await api.clearEvents()
    await loadLive()
    push('实时调试记录已清空', 'success')
  } catch (e) {
    push(`清空失败：${(e as Error).message}`, 'error')
  } finally {
    clearing.value = false
  }
}

const eventsDescription = computed(() =>
  live.value
    ? '实时调试中：新事件连同正文写进 D1，最多留 50 条；关掉页面或切到后台即停止'
    : '来自 Workers Logs，约 15 秒延迟，不含消息正文；要看正文请开实时调试',
)
/** 查不了日志时给的说明 */
const logsHint = computed(() => {
  const l = logs.value
  if (!l || l.available) return null
  if (l.reason === 'no-token')
    return {
      title: '还没配置构建 Token',
      description: '最近事件和 24 小时统计从 Workers Logs 读，要用 Worker 的 CF_BUILDS_TOKEN（带「Workers Observability 编辑」权限）。配置前可以开实时调试，或到 Cloudflare 后台的 Worker 日志页查看。',
    }
  if (l.reason === 'no-permission')
    return {
      title: '构建 Token 缺少日志权限',
      description: '到 Cloudflare 后台 → My Profile → API Tokens 编辑构建 Token，加上「Account → Workers Observability → Edit」。Token 的值不变，不用重新部署，保存后刷新这里即可。',
    }
  return { title: '读取 Workers Logs 失败', description: l.message }
})
const sampledNote = computed(() => (!live.value && logs.value?.available && logs.value.sampled ? '账户里日志量大，较早的时段是平台抽样后的结果，可能缺几条' : null))
const statPrefix = computed(() => (status.value?.stats?.sampled ? '≈' : ''))

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
        <p class="mt-1 text-lg font-semibold tabular-nums text-fg" :title="status?.stats?.sampled ? '平台抽样后的估算值' : undefined">
          {{ status?.stats ? statPrefix + status.stats.last24h : '—' }}
        </p>
      </QCard>
      <QCard>
        <p class="text-xs text-fg-muted">24 小时错误</p>
        <p
          class="mt-1 text-lg font-semibold tabular-nums"
          :class="status?.stats?.errors24h ? 'text-danger' : 'text-fg'"
          :title="status?.stats?.sampled ? '平台抽样后的估算值' : undefined"
        >
          {{ status?.stats ? statPrefix + status.stats.errors24h : '—' }}
        </p>
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

    <QCard title="最近事件" :description="eventsDescription" flush>
      <template #actions>
        <QButton v-if="live && events.length" size="sm" variant="ghost" :loading="clearing" @click="clear">
          <Trash2 class="size-3.5" aria-hidden="true" />清空
        </QButton>
        <QButton v-if="live" size="sm" @click="stopLive"><Square class="size-3.5" aria-hidden="true" />停止实时调试</QButton>
        <QButton
          v-else
          size="sm"
          :loading="liveBusy"
          :disabled="status ? !status.bindings.d1 : false"
          :title="status && !status.bindings.d1 ? '实时调试要写 D1，当前没有绑定 D1' : undefined"
          @click="startLive"
        >
          <Radio class="size-3.5" aria-hidden="true" />开始实时调试
        </QButton>
      </template>
      <p v-if="sampledNote" class="border-b border-border px-4 py-2 text-xs text-fg-muted">{{ sampledNote }}</p>
      <QEmpty v-if="!live && !logs && logsLoading" title="正在读取 Workers Logs…" description="日志查询要扫整个账户的日志，可能要十几秒。" />
      <QEmpty v-else-if="!live && logsHint" :title="logsHint.title" :description="logsHint.description" />
      <!-- 只有真实 webhook 会写记录，「调试」页的模拟是干跑，不要在这里引导过去 -->
      <QEmpty
        v-else-if="!events.length"
        title="还没有事件"
        :description="
          live
            ? '实时调试开着，机器人收到真实消息后会马上出现在这里。「调试」页的模拟事件是干跑，不计入记录。'
            : '机器人收到真实消息后，约 15 秒会出现在这里。「调试」页的模拟事件是干跑，不计入记录。'
        "
      />
      <div v-else class="overflow-x-auto">
        <table class="qb-table">
          <thead><tr><th>时间</th><th>事件</th><th>场景</th><th v-if="live">内容</th><th>命中</th><th>结果</th></tr></thead>
          <tbody>
            <tr v-for="e in events" :key="e.id">
              <td class="font-mono text-xs text-fg-muted">{{ fmtTime(e.ts) }}</td>
              <td class="font-mono text-xs">{{ e.event.replace(/^qq\./, '') }}</td>
              <td class="text-fg-muted">{{ sceneLabel[e.scene] ?? (e.scene || '—') }}</td>
              <td v-if="live" class="max-w-64 truncate" :title="e.content">{{ e.content || '—' }}</td>
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
