<script setup lang="ts">
/**
 * QQ 指令面板：群友点机器人的指令入口时弹出的可点列表。
 * 命令按插件分组、默认折叠；发送成功后把勾选和修改存进 D1，下次打开接着用，插件有增减时提醒重新发送。
 */
import { ChevronRight, Trash2 } from 'lucide-vue-next'
import { computed, ref, watch } from 'vue'
import { api } from '../../api/client.js'
import type { PluginInfo } from '../../api/types.js'
import { useConfirm } from '../../composables/useConfirm.js'
import { useToast } from '../../composables/useToast.js'
import {
  DESC_MAX,
  displayWidth,
  draftItems,
  explainPlatformError,
  ITEMS_MAX,
  mergeSaved,
  NAME_MAX,
  panelBody,
  summarizePanels,
  toSaved,
  type PanelDraftItem,
  type PanelSummary,
  type SavedPanel,
  type SavedPanelItem,
} from '../../lib/qqPanel.js'
import QButton from '../ui/QButton.vue'
import QCard from '../ui/QCard.vue'
import QCollapse from '../ui/QCollapse.vue'
import QSegmented from '../ui/QSegmented.vue'
import QTextarea from '../ui/QTextarea.vue'
import PanelCommandList from './PanelCommandList.vue'

const props = defineProps<{ plugins: PluginInfo[] }>()
const { push } = useToast()
const confirm = useConfirm()

const scope = ref('group')
const items = ref<PanelDraftItem[]>([])
/** 已经在页面上动过的以当前为准，插件列表刷新时不自动覆盖 */
const touched = ref(false)

/** 上次发送到 QQ 的记录；undefined = 还没读到，null = 没发送过 */
const saved = ref<SavedPanel | null | undefined>(undefined)
/** 没绑 D1 时记不住 */
const persist = ref(true)
const added = ref<PanelDraftItem[]>([])
const removed = ref<SavedPanelItem[]>([])

function rebuild() {
  const merged = mergeSaved(draftItems(props.plugins), saved.value ?? null)
  items.value = merged.items
  added.value = merged.added
  removed.value = merged.removed
  touched.value = false
}

async function loadSaved() {
  saved.value = undefined
  try {
    const res = await api.savedQQPanel(scope.value)
    saved.value = res.saved
    persist.value = res.persist
  } catch {
    // 读不到就当没发送过，照样能用
    saved.value = null
  }
  rebuild()
}
watch(scope, () => void loadSaved(), { immediate: true })
watch(
  () => props.plugins,
  () => {
    if (!touched.value && saved.value !== undefined) rebuild()
  },
)

/** 丢掉上次的勾选与修改，按插件现在的命令从头生成 */
function regenerate() {
  items.value = draftItems(props.plugins)
  touched.value = true
}

const fmtTime = (ms: number) => new Date(ms).toLocaleString('zh-CN', { hour12: false })

const changeNote = computed(() => {
  const parts = [
    added.value.length ? `新增 ${added.value.map((i) => i.name).join('、')}` : '',
    removed.value.length ? `已不存在 ${removed.value.map((i) => i.name).join('、')}` : '',
  ].filter(Boolean)
  const when = saved.value ? `（${fmtTime(saved.value.sentAt)}）` : ''
  return `上次发送${when}之后插件有变动：${parts.join('；')}。确认后重新发送，QQ 里的面板才会更新。`
})

const nameInvalid = (i: PanelDraftItem) => !i.name.trim() || displayWidth(i.name) > NAME_MAX
const descInvalid = (i: PanelDraftItem) => !i.desc.trim() || displayWidth(i.desc) > DESC_MAX
const problems = computed(() => {
  const chosen = items.value.filter((i) => i.selected)
  if (!chosen.length) return '至少选一个指令'
  if (chosen.length > ITEMS_MAX) return `一个面板最多 ${ITEMS_MAX} 项，现在选了 ${chosen.length} 项`
  if (chosen.some(nameInvalid)) return `有选中的指令名称为空或超过 ${NAME_MAX} 宽（约 7 个汉字）`
  if (chosen.some(descInvalid)) return `有选中的指令描述为空或超过 ${DESC_MAX} 宽（约 15 个汉字）`
  return ''
})

const busy = ref(false)
const result = ref<{ ok: boolean; text: string } | null>(null)

/** fromList：按列表发送的才存回去；直接编辑请求体发的不知道对应哪些命令，不存 */
async function send(body: unknown, fromList = true) {
  busy.value = true
  result.value = null
  try {
    const res = await api.sendQQPanels(body)
    const id = (res.data as { panel_id?: unknown } | null)?.panel_id
    result.value = res.ok
      ? { ok: true, text: `已创建${id ? `（面板 ${String(id)}）` : ''}。手机 QQ 里重新进一次会话就能看到` }
      : { ok: false, text: explainPlatformError(res.status, res.data) }
    push(res.ok ? '指令面板已创建' : '创建失败', res.ok ? 'success' : 'error')
    if (res.ok && fromList) {
      const snapshot = toSaved(items.value)
      const stored = await api.saveQQPanel(scope.value, snapshot).catch(() => null)
      persist.value = stored?.persist ?? persist.value
      if (stored?.sentAt) saved.value = { items: snapshot, sentAt: stored.sentAt }
      for (const i of items.value) i.isNew = false
      added.value = []
      removed.value = []
    }
    if (res.ok) void loadPanels()
  } catch (e) {
    result.value = { ok: false, text: (e as Error).message }
  } finally {
    busy.value = false
  }
}

const panels = ref<PanelSummary[] | null>(null)
const panelsError = ref('')
const panelsBusy = ref(false)
async function loadPanels() {
  panelsBusy.value = true
  panelsError.value = ''
  try {
    const res = await api.qqPanels(scope.value)
    if (res.ok) panels.value = summarizePanels(res.data)
    else panelsError.value = explainPlatformError(res.status, res.data)
  } catch (e) {
    panelsError.value = (e as Error).message
  } finally {
    panelsBusy.value = false
  }
}
watch(scope, () => {
  panels.value = null
  panelsError.value = ''
})

async function removePanel(p: PanelSummary) {
  if (!p.id) return
  const ok = await confirm({ title: '删除这个指令面板？', message: p.names.slice(0, 3).join('、') || p.id, confirmText: '删除', danger: true })
  if (!ok) return
  panelsBusy.value = true
  try {
    const res = await api.deleteQQPanel(p.id)
    if (res.ok) push('已删除', 'success')
    else push(`删除失败：${explainPlatformError(res.status, res.data)}`, 'error')
  } catch (e) {
    push(`删除失败：${(e as Error).message}`, 'error')
  } finally {
    panelsBusy.value = false
  }
  await loadPanels()
}

/** 高级：直接编辑请求体。展开时按当前勾选生成一份 */
const rawBody = ref('')
const rawOpen = ref(false)
function toggleRaw() {
  rawOpen.value = !rawOpen.value
  if (rawOpen.value) rawBody.value = JSON.stringify(panelBody(scope.value, items.value), null, 2)
}
function sendRaw() {
  let body: unknown
  try {
    body = JSON.parse(rawBody.value)
  } catch {
    result.value = { ok: false, text: '请求体不是合法的 JSON' }
    return
  }
  void send(body, false)
}
</script>

<template>
  <QCard title="QQ 指令面板" description="群友点机器人的指令入口时弹出的可点列表，点一下就发出对应指令，不用记命令名">
    <template #actions>
      <QButton size="sm" variant="ghost" @click="regenerate">按插件重新生成</QButton>
    </template>
    <div class="flex flex-col gap-4">
      <QSegmented v-model="scope" :options="[{ value: 'group', label: '群聊' }, { value: 'c2c', label: '单聊' }]" label="面板用在哪里" />

      <p
        v-if="saved !== undefined"
        class="rounded-md px-3 py-2 text-xs"
        :class="added.length || removed.length ? 'bg-warning-bg text-warning' : 'bg-surface-muted text-fg-muted'"
        role="status"
      >
        <template v-if="!persist">没有绑定 D1，记不住上次发送的内容，每次都按插件重新生成。</template>
        <template v-else-if="!saved">还没发送过。发送成功后会记住这里的勾选和修改，插件有变动时也会提醒你重新发送。</template>
        <template v-else-if="added.length || removed.length">{{ changeNote }}</template>
        <template v-else>和 {{ fmtTime(saved.sentAt) }} 发送到 QQ 的一致。</template>
      </p>

      <PanelCommandList :items="items" @touch="touched = true" />

      <p class="text-xs text-fg-subtle">名称要和命令名或别名一致；宽度按汉字算 2、英文算 1。声明了权限的命令会设成「仅管理员可点」。每分钟最多创建 10 次。</p>

      <div class="flex flex-wrap items-center gap-2">
        <QButton variant="primary" :loading="busy" :disabled="!!problems" @click="send(panelBody(scope, items))">发送到 QQ</QButton>
        <QButton :loading="panelsBusy" @click="loadPanels">查看已有的面板</QButton>
        <span v-if="problems" class="text-xs text-danger">{{ problems }}</span>
      </div>

      <p v-if="result" class="rounded-md px-3 py-2 text-sm" :class="result.ok ? 'bg-success-bg text-success' : 'bg-danger-bg text-danger'" role="status">{{ result.text }}</p>

      <QCollapse :open="!!panels || !!panelsError">
        <div class="flex flex-col gap-2">
          <p class="text-sm font-medium text-fg">已有的面板（{{ scope === 'group' ? '群聊' : '单聊' }}）</p>
          <p v-if="panelsError" class="text-sm text-danger">{{ panelsError }}</p>
          <p v-else-if="!panels?.length" class="text-sm text-fg-muted">还没有面板。</p>
          <ul v-else class="flex flex-col divide-y divide-border rounded-lg border border-border">
            <li v-for="p in panels" :key="p.id" class="flex items-start gap-3 px-4 py-3">
              <div class="min-w-0 flex-1">
                <p class="truncate font-mono text-xs text-fg-muted">{{ p.id || '（没有 id）' }}<span v-if="p.targetType"> · {{ p.targetType === 'all' ? '全部' : p.targetType }}</span></p>
                <p class="mt-1 text-sm text-fg">{{ p.names.join('、') || '（没有读到指令）' }}</p>
              </div>
              <QButton size="sm" variant="ghost" :disabled="!p.id || panelsBusy" @click="removePanel(p)"><Trash2 class="size-3.5" aria-hidden="true" />删除</QButton>
            </li>
          </ul>
        </div>
      </QCollapse>

      <div class="text-sm">
        <button
          type="button"
          class="inline-flex cursor-pointer items-center gap-1 text-left text-xs text-fg-muted transition-colors duration-(--qb-duration) hover:text-fg"
          :aria-expanded="rawOpen"
          aria-controls="panel-raw-box"
          @click="toggleRaw"
        >
          <ChevronRight class="size-3.5 shrink-0 transition-transform duration-(--qb-duration)" :class="rawOpen && 'rotate-90'" aria-hidden="true" />
          高级：直接编辑请求体（按定点群、用户生效等特殊配置时用）
        </button>
        <QCollapse id="panel-raw-box" :open="rawOpen">
          <div class="flex flex-col gap-2 pt-3">
            <QTextarea id="panel-raw" v-model="rawBody" mono :rows="10" aria-label="请求体 JSON" />
            <div><QButton :loading="busy" :disabled="!rawBody.trim()" @click="sendRaw">按这份请求体发送</QButton></div>
          </div>
        </QCollapse>
      </div>
    </div>
  </QCard>
</template>
