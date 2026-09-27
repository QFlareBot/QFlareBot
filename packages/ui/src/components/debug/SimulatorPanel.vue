<script setup lang="ts">
/**
 * 事件模拟器：干跑 /admin/test-event，不碰 QQ。
 * 用聊天气泡展示插件会怎么回，按键可以直接点。
 */
import { Eraser, MousePointerClick, Play, Settings2 } from 'lucide-vue-next'
import { computed, nextTick, ref, watch } from 'vue'
import { api } from '../../api/client.js'
import type { TestEventResult } from '../../api/types.js'
import type { PreviewButton } from '../../lib/outgoing.js'
import { useStatus } from '../../composables/useStatus.js'
import { useToast } from '../../composables/useToast.js'
import QButton from '../ui/QButton.vue'
import QCard from '../ui/QCard.vue'
import QCollapse from '../ui/QCollapse.vue'
import QEmpty from '../ui/QEmpty.vue'
import QField from '../ui/QField.vue'
import QInput from '../ui/QInput.vue'
import QSelect from '../ui/QSelect.vue'
import ChatMessage from './ChatMessage.vue'
import RunDetails from './RunDetails.vue'

interface Turn {
  at: number
  /** 参与者看到的那句话：消息内容，或「点击按键 …」 */
  input: string
  kind: 'message' | 'button' | 'raw'
  result: TestEventResult
}

const { plugins } = useStatus()
const { push } = useToast()

const kind = ref<'message' | 'button' | 'raw'>('message')
const scene = ref('group')
const targetId = ref('test-group')
const userId = ref('test-user')
const content = ref('/sid')
const buttonId = ref('')
const buttonData = ref('')
const rawType = ref('GROUP_ADD_ROBOT')
const running = ref(false)
const showSettings = ref(false)

const turns = ref<Turn[]>([])
const openDetails = ref(new Set<number>())
const viewport = ref<HTMLElement | null>(null)

const SCENES = [
  { value: 'group', label: '群聊' },
  { value: 'c2c', label: '单聊' },
  { value: 'guild', label: '频道' },
]
const KINDS = [
  { value: 'message', label: '消息' },
  { value: 'button', label: '按键点击' },
  { value: 'raw', label: '其他事件' },
]
const RAW_TYPES = ['GROUP_ADD_ROBOT', 'GROUP_DEL_ROBOT', 'GROUP_MEMBER_ADD', 'GROUP_MEMBER_REMOVE', 'FRIEND_ADD', 'C2C_MSG_RECEIVE', 'GROUP_MSG_RECEIVE'].map((v) => ({ value: v, label: v }))
const knownButtons = computed(() => plugins.value.flatMap((p) => p.buttons.map((b) => ({ value: b, label: `${b}（${p.displayName}）` }))))
/** 命令补全：已启用插件的命令与别名 */
const commands = computed(() =>
  plugins.value
    .filter((p) => p.enabled)
    .flatMap((p) => p.commands.flatMap((c) => [c.name, ...(c.aliases ?? [])].map((n) => ({ name: n, plugin: p.displayName, description: c.description })))),
)
const sceneLabel = computed(() => SCENES.find((s) => s.value === scene.value)?.label ?? scene.value)

async function run(payload?: { kind: Turn['kind']; input: string; body: Record<string, unknown> }) {
  const active = payload ?? (() => {
    if (kind.value === 'button') {
      return {
        kind: 'button' as const,
        input: `点击按键 ${buttonId.value}${buttonData.value ? `（${buttonData.value}）` : ''}`,
        body: { scene: scene.value, targetId: targetId.value, userId: userId.value, buttonId: buttonId.value, buttonData: buttonData.value },
      }
    }
    if (kind.value === 'raw') {
      return { kind: 'raw' as const, input: rawType.value, body: { scene: scene.value, targetId: targetId.value, userId: userId.value, rawType: rawType.value, content: '' } }
    }
    return { kind: 'message' as const, input: content.value, body: { scene: scene.value, targetId: targetId.value, userId: userId.value, content: content.value } }
  })()
  running.value = true
  await nextTick()
  try {
    const result = await api.testEvent(active.body)
    turns.value.push({ at: Date.now(), input: active.input, kind: active.kind, result })
    if (turns.value.length > 12) turns.value.shift()
  } catch (e) {
    push(`模拟失败：${(e as Error).message}`, 'error')
  } finally {
    running.value = false
  }
}

function sendMessage() {
  if (running.value) return
  if (kind.value === 'message' && !content.value.trim()) return
  if (kind.value === 'button' && !buttonId.value.trim()) return
  void run()
}
function quickCommand(name: string) {
  kind.value = 'message'
  content.value = `/${name}`
  sendMessage()
}
function onButton(b: PreviewButton) {
  if (b.action === 0) {
    if (/^https?:\/\//i.test(b.data)) window.open(b.data, '_blank', 'noopener')
    return
  }
  if (b.action === 2) {
    content.value = b.data
    kind.value = 'message'
    if (b.enter) sendMessage()
    return
  }
  if (running.value) return
  void run({
    kind: 'button',
    input: `点击按键 ${b.id}${b.data ? `（${b.data}）` : ''}`,
    body: { scene: scene.value, targetId: targetId.value, userId: userId.value, buttonId: b.id, buttonData: b.data },
  })
}
function toggleDetails(at: number) {
  const next = new Set(openDetails.value)
  if (next.has(at)) next.delete(at)
  else next.add(at)
  openDetails.value = next
}

// 新一轮出现或开始处理时滚到底
watch([() => turns.value.length, running], async () => {
  await nextTick()
  viewport.value?.scrollTo({ top: viewport.value.scrollHeight, behavior: 'smooth' })
})
const time = (at: number) => new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
</script>

<template>
  <QCard title="对话预览">
    <template #actions>
      <QButton size="sm" variant="ghost" :aria-expanded="showSettings" @click="showSettings = !showSettings">
        <Settings2 class="size-3.5" aria-hidden="true" />{{ sceneLabel }} · <span class="font-mono">{{ targetId }}</span>
      </QButton>
      <QButton v-if="turns.length" size="sm" variant="ghost" @click="turns = []; openDetails = new Set()"><Eraser class="size-3.5" aria-hidden="true" />清空</QButton>
    </template>

    <QCollapse :open="showSettings">
      <div class="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <QField id="dbg-scene" label="场景"><QSelect id="dbg-scene" v-model="scene" :options="SCENES" /></QField>
        <QField id="dbg-target" label="目标 ID" hint="群 / 用户 openid"><QInput id="dbg-target" v-model="targetId" mono /></QField>
        <QField id="dbg-user" label="发送者 openid"><QInput id="dbg-user" v-model="userId" mono /></QField>
      </div>
    </QCollapse>

    <div ref="viewport" class="flex h-[clamp(20rem,52vh,34rem)] flex-col gap-3 overflow-y-auto rounded-lg bg-surface-muted/50 p-3">
      <QEmpty
        v-if="!turns.length"
        :icon="MousePointerClick"
        title="模拟一条消息，看看机器人会怎么回"
        description="这里是干跑：回复只记录不发给 QQ。插件自己的存储读写会真的发生。"
      >
        <QButton v-for="c in commands.slice(0, 4)" :key="c.name" size="sm" @click="quickCommand(c.name)">/{{ c.name }}</QButton>
      </QEmpty>

      <template v-for="t in turns" :key="t.at">
        <div class="flex justify-end">
          <div class="flex max-w-[min(28rem,85%)] flex-col items-end gap-1">
            <p class="rounded-2xl rounded-tr-md bg-primary px-3.5 py-2 text-sm break-words whitespace-pre-wrap text-on-primary">{{ t.input }}</p>
            <span class="text-xs text-fg-subtle">{{ time(t.at) }}</span>
          </div>
        </div>
        <div class="flex flex-col gap-1.5">
          <ChatMessage v-for="(o, i) in t.result.outbox" :key="i" :message="o.message" :label="`→ ${o.target.scene}:${o.target.id}`" @button="onButton" />
          <p v-for="a in t.result.acks" :key="a.interactionId" class="text-xs" :class="a.code === 0 ? 'text-fg-muted' : 'text-warning'">
            交互回应 code {{ a.code }}<span v-if="a.code === 5">（仅管理员）</span>
          </p>
          <p v-for="(e, i) in t.result.errors" :key="i" class="rounded-lg bg-danger-bg px-3 py-2 text-xs text-danger">{{ e.plugin }} · {{ e.stage }}：{{ e.message }}</p>
          <p v-if="!t.result.outbox.length && !t.result.errors.length" class="text-xs text-fg-subtle">没有回复（插件可能只是静默处理了这条事件）</p>
          <RunDetails :result="t.result" :open="openDetails.has(t.at)" @toggle="toggleDetails(t.at)" />
        </div>
      </template>
      <p v-if="running" class="flex items-center gap-2 text-xs text-fg-muted" role="status"><span class="qb-pulse size-2 rounded-full bg-accent" aria-hidden="true" />插件处理中…</p>
    </div>

    <form class="mt-3 flex flex-col gap-2" @submit.prevent="sendMessage">
      <div class="flex flex-wrap items-center gap-2">
        <QSelect v-model="kind" :options="KINDS" class="w-28" aria-label="事件类型" />
        <template v-if="kind === 'message'">
          <QInput v-model="content" class="min-w-0 flex-1 basis-48" placeholder="发给机器人的消息，如 /sid" aria-label="消息内容" />
        </template>
        <template v-else-if="kind === 'button'">
          <QSelect v-if="knownButtons.length" v-model="buttonId" :options="[{ value: '', label: '选择按键…' }, ...knownButtons]" class="min-w-0 flex-1 basis-40" aria-label="按键 id" />
          <QInput v-else v-model="buttonId" class="min-w-0 flex-1 basis-40" mono placeholder="按键 id" aria-label="按键 id" />
          <QInput v-model="buttonData" class="min-w-0 flex-1 basis-32" mono placeholder="按键 data" aria-label="按键 data" />
        </template>
        <QSelect v-else v-model="rawType" :options="RAW_TYPES" class="min-w-0 flex-1 basis-48" aria-label="事件类型" />
        <QButton type="submit" variant="primary" :loading="running"><Play class="size-3.5" aria-hidden="true" />发送模拟事件</QButton>
      </div>
      <div v-if="kind === 'message' && commands.length" class="flex flex-wrap items-center gap-1">
        <span class="text-xs text-fg-subtle">可用命令</span>
        <button
          v-for="c in commands.slice(0, 8)"
          :key="c.name"
          type="button"
          class="h-6 cursor-pointer rounded-full bg-surface-muted px-2 font-mono text-xs text-fg-muted transition-colors duration-(--qb-duration) hover:text-fg"
          :title="`${c.plugin}：${c.description ?? ''}`"
          @click="content = `/${c.name}`"
        >
          /{{ c.name }}
        </button>
        <span v-if="commands.length > 8" class="text-xs text-fg-subtle">等 {{ commands.length }} 个</span>
      </div>
    </form>
  </QCard>
</template>
