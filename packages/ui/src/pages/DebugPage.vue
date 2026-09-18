<script setup lang="ts">
/**
 * 两块互不相干的东西放在同一页：
 * 上面的事件模拟器是**干跑**，走 /admin/test-event，不碰 QQ；
 * 下面的主动发消息是**真发**，走 /admin/send，对方会真的收到。
 */
import { Play, Send } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import { api } from '../api/client.js'
import type { TestEventResult } from '../api/types.js'
import PageHeader from '../components/PageHeader.vue'
import QBadge from '../components/ui/QBadge.vue'
import QButton from '../components/ui/QButton.vue'
import QCard from '../components/ui/QCard.vue'
import QCode from '../components/ui/QCode.vue'
import QEmpty from '../components/ui/QEmpty.vue'
import QField from '../components/ui/QField.vue'
import QInput from '../components/ui/QInput.vue'
import QSelect from '../components/ui/QSelect.vue'
import StatusDot from '../components/ui/StatusDot.vue'
import { useStatus } from '../composables/useStatus.js'
import { useToast } from '../composables/useToast.js'

const { plugins } = useStatus()
const { push } = useToast()

const kind = ref<'message' | 'button' | 'raw'>('message')
const scene = ref<'group' | 'c2c' | 'guild'>('group')
const targetId = ref('test-group')
const userId = ref('test-user')
const content = ref('/echo 你好')
const buttonId = ref('')
const buttonData = ref('')
const rawType = ref('GROUP_ADD_ROBOT')
const running = ref(false)

interface Run {
  at: number
  input: string
  result: TestEventResult
}
const runs = ref<Run[]>([])
const latest = computed(() => runs.value[0])

const knownButtons = computed(() => plugins.value.flatMap((p) => p.buttons.map((b) => ({ value: b, label: `${b}（${p.displayName}）` }))))
const knownCommands = computed(() => plugins.value.flatMap((p) => p.commands.map((c) => `/${c.name}`)))

async function run() {
  const body: Record<string, unknown> = { scene: scene.value, targetId: targetId.value, userId: userId.value }
  let label = ''
  if (kind.value === 'button') {
    body.buttonId = buttonId.value
    body.buttonData = buttonData.value
    label = `点击按键 ${buttonId.value}${buttonData.value ? `（${buttonData.value}）` : ''}`
  } else if (kind.value === 'raw') {
    body.rawType = rawType.value
    body.content = ''
    label = rawType.value
  } else {
    body.content = content.value
    label = content.value
  }
  running.value = true
  try {
    const result = await api.testEvent(body)
    runs.value.unshift({ at: Date.now(), input: label, result })
    if (runs.value.length > 10) runs.value.pop()
  } catch (e) {
    push(`模拟失败：${(e as Error).message}`, 'error')
  } finally {
    running.value = false
  }
}

// ---- 主动发消息：真的调用 QQ 接口 ----
const sendScene = ref<'group' | 'c2c'>('group')
const sendTargetId = ref('')
const sendText = ref('')
const sending = ref(false)
const sendResult = ref<{ ok: boolean; text: string } | null>(null)

async function send() {
  if (!sendTargetId.value.trim() || !sendText.value.trim()) return
  sending.value = true
  sendResult.value = null
  try {
    const { result } = await api.send(sendScene.value, sendTargetId.value.trim(), sendText.value)
    sendResult.value = result.ok
      ? { ok: true, text: `已发送${result.messageId ? `，message_id ${result.messageId}` : ''}` }
      : { ok: false, text: result.error ?? `QQ 返回 HTTP ${result.status}` }
    if (result.ok) push('消息已发送', 'success')
    else push('发送失败', 'error')
  } catch (e) {
    sendResult.value = { ok: false, text: (e as Error).message }
    push(`发送失败：${(e as Error).message}`, 'error')
  } finally {
    sending.value = false
  }
}

const sendSceneOptions = [
  { value: 'group', label: '群聊' },
  { value: 'c2c', label: '单聊' },
]

const sceneOptions = [
  { value: 'group', label: '群聊' },
  { value: 'c2c', label: '单聊' },
  { value: 'guild', label: '频道' },
]
const kindOptions = [
  { value: 'message', label: '消息' },
  { value: 'button', label: '按键点击' },
  { value: 'raw', label: '其他事件' },
]
const rawOptions = ['GROUP_ADD_ROBOT', 'GROUP_DEL_ROBOT', 'GROUP_MEMBER_ADD', 'GROUP_MEMBER_REMOVE', 'FRIEND_ADD', 'C2C_MSG_RECEIVE', 'GROUP_MSG_RECEIVE'].map((v) => ({ value: v, label: v }))
</script>

<template>
  <div>
    <PageHeader title="调试" description="事件模拟器是干跑，不碰 QQ；下面的主动发消息会真的发出去。" />
    <div class="grid gap-4 lg:grid-cols-[360px_1fr]">
      <QCard title="事件模拟器">
        <form class="flex flex-col gap-4" @submit.prevent="run">
          <QField id="kind" label="类型"><QSelect id="kind" v-model="kind" :options="kindOptions" /></QField>
          <div class="grid grid-cols-2 gap-3">
            <QField id="scene" label="场景"><QSelect id="scene" v-model="scene" :options="sceneOptions" /></QField>
            <QField id="target" label="目标 ID" hint="群 / 用户 openid"><QInput id="target" v-model="targetId" mono /></QField>
          </div>
          <QField id="user" label="发送者 openid"><QInput id="user" v-model="userId" mono /></QField>

          <template v-if="kind === 'message'">
            <QField id="content" label="消息内容" :hint="knownCommands.length ? `可用命令：${knownCommands.slice(0, 6).join(' ')}` : undefined">
              <QInput id="content" v-model="content" />
            </QField>
          </template>
          <template v-else-if="kind === 'button'">
            <QField id="btn" label="按键 id">
              <QSelect v-if="knownButtons.length" id="btn" v-model="buttonId" :options="[{ value: '', label: '选择…' }, ...knownButtons]" />
              <QInput v-else id="btn" v-model="buttonId" mono />
            </QField>
            <QField id="btn-data" label="按键 data"><QInput id="btn-data" v-model="buttonData" mono /></QField>
          </template>
          <template v-else>
            <QField id="raw" label="事件类型"><QSelect id="raw" v-model="rawType" :options="rawOptions" /></QField>
          </template>

          <QButton type="submit" variant="primary" :loading="running"><Play class="size-3.5" aria-hidden="true" />发送模拟事件</QButton>
        </form>
      </QCard>

      <QCard title="主动发消息" description="真的调用 QQ 接口，对方会收到。主动消息有条数配额。" class="lg:col-start-1">
        <form class="flex flex-col gap-4" @submit.prevent="send">
          <div class="grid grid-cols-2 gap-3">
            <QField id="send-scene" label="场景"><QSelect id="send-scene" v-model="sendScene" :options="sendSceneOptions" /></QField>
            <QField id="send-target" label="目标 openid" hint="群 openid 或用户 openid">
              <QInput id="send-target" v-model="sendTargetId" mono />
            </QField>
          </div>
          <QField id="send-text" label="消息内容"><QInput id="send-text" v-model="sendText" /></QField>
          <QButton type="submit" variant="primary" :loading="sending" :disabled="!sendTargetId.trim() || !sendText.trim()">
            <Send class="size-3.5" aria-hidden="true" />真实发送
          </QButton>
          <p v-if="sendResult" class="text-sm">
            <StatusDot :tone="sendResult.ok ? 'success' : 'danger'" :label="sendResult.text" />
          </p>
        </form>
      </QCard>

      <div class="flex flex-col gap-4">
        <QCard v-if="!latest" flush>
          <QEmpty title="还没有运行结果" description="左侧填好后发送，这里会显示会话解析、命中的插件与它们的出站动作。" />
        </QCard>
        <template v-else>
          <QCard title="结果" :description="`${latest.input} · ${new Date(latest.at).toLocaleTimeString('zh-CN', { hour12: false })}`">
            <dl class="grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-4">
              <div><dt class="text-xs text-fg-muted">事件</dt><dd class="font-mono text-xs">{{ latest.result.session.event }}</dd></div>
              <div><dt class="text-xs text-fg-muted">场景</dt><dd>{{ latest.result.session.scene }}</dd></div>
              <div><dt class="text-xs text-fg-muted">可被动回复</dt><dd>{{ latest.result.session.canReply ? '是' : '否' }}</dd></div>
              <div><dt class="text-xs text-fg-muted">命中</dt><dd>{{ latest.result.matched.length }} 个处理器</dd></div>
            </dl>
            <div class="mt-3 flex flex-wrap gap-1">
              <QBadge v-for="m in latest.result.matched" :key="m.plugin + m.kind + m.name" tone="accent">{{ m.plugin }} · {{ m.kind }} · {{ m.name }}</QBadge>
              <span v-if="!latest.result.matched.length" class="text-sm text-fg-muted">没有插件命中这条事件</span>
            </div>
            <ul v-if="latest.result.errors.length" class="mt-3 flex flex-col gap-1">
              <li v-for="(e, i) in latest.result.errors" :key="i" class="rounded-md bg-danger-bg px-3 py-2 text-sm">
                <StatusDot tone="danger" :label="`${e.plugin} · ${e.stage}`" /><p class="mt-0.5 font-mono text-xs text-danger">{{ e.message }}</p>
              </li>
            </ul>
          </QCard>

          <QCard title="出站动作" :description="`${latest.result.outbox.length} 条消息 · ${latest.result.acks.length} 次交互回应 · ${latest.result.streams.length} 个流式分片 · ${latest.result.recalls.length} 次撤回`">
            <QEmpty v-if="!latest.result.outbox.length && !latest.result.acks.length && !latest.result.streams.length" title="没有出站动作" />
            <div v-else class="flex flex-col gap-3">
              <div v-for="(o, i) in latest.result.outbox" :key="i" class="rounded-md border border-border">
                <div class="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-fg-muted">
                  <QBadge>{{ o.options?.messageId ? '被动回复' : o.options?.eventId ? '事件回复' : '主动消息' }}</QBadge>
                  <span class="font-mono">→ {{ o.target.scene }}:{{ o.target.id }}</span>
                  <span v-if="o.options?.msgSeq" class="font-mono">seq {{ o.options.msgSeq }}</span>
                </div>
                <div class="p-3">
                  <p v-if="typeof o.message === 'string'" class="text-sm whitespace-pre-wrap">{{ o.message }}</p>
                  <QCode v-else :value="o.message" />
                </div>
              </div>
              <div v-for="a in latest.result.acks" :key="a.interactionId" class="text-sm">
                <StatusDot :tone="a.code === 0 ? 'success' : 'warning'" :label="`交互回应 code ${a.code}`" />
              </div>
              <QCode v-if="latest.result.streams.length" :value="latest.result.streams" />
            </div>
          </QCard>
        </template>

        <QCard v-if="runs.length > 1" title="历史" flush>
          <ul class="divide-y divide-border">
            <li v-for="(r, i) in runs.slice(1)" :key="r.at" class="flex items-center justify-between gap-3 px-4 py-2 text-sm">
              <span class="truncate">{{ r.input }}</span>
              <span class="flex shrink-0 items-center gap-2 text-xs text-fg-muted">
                <span>{{ r.result.matched.length }} 命中</span>
                <span v-if="r.result.errors.length" class="text-danger">{{ r.result.errors.length }} 错误</span>
                <QButton size="sm" variant="ghost" @click="runs.unshift(...runs.splice(i + 1, 1))">查看</QButton>
              </span>
            </li>
          </ul>
        </QCard>
      </div>
    </div>
  </div>
</template>
