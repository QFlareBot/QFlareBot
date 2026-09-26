<script setup lang="ts">
import { Trash2 } from 'lucide-vue-next'
import { computed, ref, watch } from 'vue'
import { api } from '../api/client.js'
import type { PluginInfo } from '../api/types.js'
import { useToast } from '../composables/useToast.js'
import {
  DESC_MAX,
  displayWidth,
  draftItems,
  explainPlatformError,
  ITEMS_MAX,
  NAME_MAX,
  panelBody,
  summarizePanels,
  type PanelDraftItem,
  type PanelSummary,
} from '../lib/qqPanel.js'
import QBadge from './ui/QBadge.vue'
import QButton from './ui/QButton.vue'
import QCard from './ui/QCard.vue'
import QField from './ui/QField.vue'
import QInput from './ui/QInput.vue'
import QSelect from './ui/QSelect.vue'
import QTextarea from './ui/QTextarea.vue'

const props = defineProps<{ plugins: PluginInfo[] }>()
const { push } = useToast()

const scope = ref('group')
const items = ref<PanelDraftItem[]>([])
/** 插件列表变了（启用 / 停用、装了新插件）就重新整理；已经手改过的以当前为准，不自动覆盖 */
const touched = ref(false)
watch(
  () => props.plugins,
  (plugins) => {
    if (!touched.value) items.value = draftItems(plugins)
  },
  { immediate: true },
)
function regenerate() {
  items.value = draftItems(props.plugins)
  touched.value = false
}

const selectedCount = computed(() => items.value.filter((i) => i.selected).length)
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

async function send(body: unknown) {
  busy.value = true
  result.value = null
  try {
    const res = await api.sendQQPanels(body)
    const id = (res.data as { panel_id?: unknown } | null)?.panel_id
    result.value = res.ok
      ? { ok: true, text: `已创建${id ? `（面板 ${String(id)}）` : ''}。手机 QQ 里重新进一次会话就能看到` }
      : { ok: false, text: explainPlatformError(res.status, res.data) }
    push(res.ok ? '指令面板已创建' : '创建失败', res.ok ? 'success' : 'error')
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
  if (!p.id || !confirm(`删除这个指令面板（${p.names.slice(0, 3).join('、') || p.id}）？`)) return
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
const rawOpen = ref(false)
const rawBody = ref('')
function onRawToggle(e: Event) {
  rawOpen.value = (e.target as HTMLDetailsElement).open
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
  void send(body)
}
</script>

<template>
  <QCard
    title="QQ 指令面板"
    description="群友点机器人的指令入口时弹出的可点列表，点一下就发出对应指令，不用记命令名"
    flush
  >
    <div class="flex flex-col gap-4 p-4">
      <div class="flex flex-wrap items-end gap-3">
        <QField id="panel-scope" label="用在哪里">
          <template #default>
            <QSelect id="panel-scope" v-model="scope" :options="[{ label: '群聊', value: 'group' }, { label: '单聊', value: 'c2c' }]" />
          </template>
        </QField>
        <p class="pb-1.5 text-xs text-fg-muted">
          已选 <span class="tabular-nums" :class="selectedCount > ITEMS_MAX ? 'text-danger' : 'text-fg'">{{ selectedCount }}/{{ ITEMS_MAX }}</span> 项
        </p>
        <QButton size="sm" variant="ghost" class="ml-auto" @click="regenerate">按已启用插件重新生成</QButton>
      </div>

      <p v-if="!items.length" class="text-sm text-fg-muted">已启用的插件里没有命令。</p>
      <ul v-else class="flex flex-col divide-y divide-border rounded-md border border-border">
        <li v-for="(item, i) in items" :key="i" class="flex flex-col gap-2 p-3 sm:flex-row sm:items-start">
          <label class="flex shrink-0 items-center gap-2 sm:w-40 sm:pt-1.5">
            <input v-model="item.selected" type="checkbox" class="size-4 accent-(--qb-accent)" :disabled="item.tooWide" @change="touched = true" />
            <span class="min-w-0 truncate text-xs text-fg-muted">{{ item.plugin }}</span>
          </label>
          <div class="grid min-w-0 flex-1 gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <div>
              <QInput
                v-model="item.name"
                :invalid="item.selected && nameInvalid(item)"
                :aria-label="`指令名称 ${i + 1}`"
                @update:model-value="touched = true"
              />
              <p class="mt-1 text-xs" :class="displayWidth(item.name) > NAME_MAX ? 'text-danger' : 'text-fg-subtle'">
                <template v-if="item.tooWide">命令名和别名都太长，放不进面板（名称要和命令对得上，不能截断）</template>
                <template v-else>名称 {{ displayWidth(item.name) }}/{{ NAME_MAX }}</template>
              </p>
            </div>
            <div>
              <QInput
                v-model="item.desc"
                :invalid="item.selected && descInvalid(item)"
                :aria-label="`指令描述 ${i + 1}`"
                @update:model-value="touched = true"
              />
              <p class="mt-1 flex items-center gap-2 text-xs" :class="displayWidth(item.desc) > DESC_MAX ? 'text-danger' : 'text-fg-subtle'">
                描述 {{ displayWidth(item.desc) }}/{{ DESC_MAX }}
                <QBadge v-if="item.onlyAdmin" tone="warning">仅管理员可点</QBadge>
              </p>
            </div>
          </div>
        </li>
      </ul>

      <p class="text-xs text-fg-muted">
        名称要和命令名或别名一致，点了才对得上；宽度按汉字算 2、英文算 1。声明了权限的命令会设成「仅管理员可点」。创建太频繁会被限流（每分钟 10 次）。
      </p>

      <div class="flex flex-wrap items-center gap-2">
        <QButton variant="primary" :loading="busy" :disabled="!!problems" @click="send(panelBody(scope, items))">发送到 QQ</QButton>
        <QButton :loading="panelsBusy" @click="loadPanels">查看已有的面板</QButton>
        <span v-if="problems" class="text-xs text-danger">{{ problems }}</span>
      </div>

      <p v-if="result" class="rounded-md px-3 py-2 text-sm" :class="result.ok ? 'bg-success-bg text-success' : 'bg-danger-bg text-danger'" role="status">
        {{ result.text }}
      </p>

      <div v-if="panels || panelsError" class="flex flex-col gap-2">
        <p class="text-sm font-medium text-fg">已有的面板（{{ scope === 'group' ? '群聊' : '单聊' }}）</p>
        <p v-if="panelsError" class="text-sm text-danger">{{ panelsError }}</p>
        <p v-else-if="!panels?.length" class="text-sm text-fg-muted">还没有面板。</p>
        <ul v-else class="flex flex-col divide-y divide-border rounded-md border border-border">
          <li v-for="p in panels" :key="p.id" class="flex items-start gap-3 p-3">
            <div class="min-w-0 flex-1">
              <p class="truncate font-mono text-xs text-fg-muted">{{ p.id || '（没有 id）' }}<span v-if="p.targetType"> · {{ p.targetType === 'all' ? '全部' : p.targetType }}</span></p>
              <p class="mt-1 text-sm text-fg">{{ p.names.join('、') || '（没有读到指令）' }}</p>
            </div>
            <QButton size="sm" variant="ghost" :disabled="!p.id || panelsBusy" @click="removePanel(p)"><Trash2 class="size-3.5" aria-hidden="true" />删除</QButton>
          </li>
        </ul>
      </div>

      <details class="text-sm" @toggle="onRawToggle">
        <summary class="cursor-pointer text-xs text-fg-muted">高级：直接编辑请求体（按定点群、用户生效等特殊配置时用）</summary>
        <div class="mt-3 flex flex-col gap-2">
          <QTextarea id="panel-raw" v-model="rawBody" mono :rows="10" aria-label="请求体 JSON" />
          <div><QButton :loading="busy" :disabled="!rawBody.trim()" @click="sendRaw">按这份请求体发送</QButton></div>
        </div>
      </details>
    </div>
  </QCard>
</template>
