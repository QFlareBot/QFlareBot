<script setup lang="ts">
/** 真实发送：走 /admin/send，真的调用 QQ 接口，对方会收到；主动消息有条数配额 */
import { Send, TriangleAlert } from 'lucide-vue-next'
import { ref } from 'vue'
import { api } from '../../api/client.js'
import { useToast } from '../../composables/useToast.js'
import QButton from '../ui/QButton.vue'
import QCard from '../ui/QCard.vue'
import QField from '../ui/QField.vue'
import QInput from '../ui/QInput.vue'
import QSelect from '../ui/QSelect.vue'
import QTextarea from '../ui/QTextarea.vue'
import StatusDot from '../ui/StatusDot.vue'

const { push } = useToast()
const scene = ref<'group' | 'c2c'>('group')
const targetId = ref('')
const text = ref('')
const sending = ref(false)
/** 这次打开页面以来发过的，最新的在上面 */
const log = ref<Array<{ at: number; target: string; text: string; ok: boolean; detail: string }>>([])

async function send() {
  const target = targetId.value.trim()
  if (!target || !text.value.trim() || sending.value) return
  sending.value = true
  const entry = { at: Date.now(), target: `${scene.value === 'group' ? '群' : '单聊'} ${target}`, text: text.value, ok: false, detail: '' }
  try {
    const { result } = await api.send(scene.value, target, text.value)
    entry.ok = result.ok
    entry.detail = result.ok ? `已发送${result.messageId ? `，message_id ${result.messageId}` : ''}` : (result.error ?? `QQ 返回 HTTP ${result.status}`)
    push(result.ok ? '消息已发送' : '发送失败', result.ok ? 'success' : 'error')
    if (result.ok) text.value = ''
  } catch (e) {
    entry.detail = (e as Error).message
    push(`发送失败：${entry.detail}`, 'error')
  } finally {
    log.value = [entry, ...log.value].slice(0, 10)
    sending.value = false
  }
}
</script>

<template>
  <div class="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
    <QCard title="主动发消息">
      <p class="mb-4 flex items-start gap-2 rounded-md bg-warning-bg px-3 py-2 text-xs text-warning">
        <TriangleAlert class="mt-px size-3.5 shrink-0" aria-hidden="true" />会真的发到 QQ，对方会收到。主动消息每月有条数配额。
      </p>
      <form class="flex flex-col gap-4" @submit.prevent="send">
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
          <QField id="send-scene" label="场景">
            <QSelect id="send-scene" v-model="scene" :options="[{ value: 'group', label: '群聊' }, { value: 'c2c', label: '单聊' }]" />
          </QField>
          <QField id="send-target" label="目标 openid" hint="群 openid 或用户 openid，在会话里发 /sid 查看">
            <template #default="{ describedBy }"><QInput id="send-target" v-model="targetId" mono :described-by="describedBy" /></template>
          </QField>
        </div>
        <QField id="send-text" label="消息内容">
          <QTextarea id="send-text" v-model="text" :rows="3" />
        </QField>
        <div>
          <QButton type="submit" variant="primary" :loading="sending" :disabled="!targetId.trim() || !text.trim()"><Send class="size-3.5" aria-hidden="true" />真实发送</QButton>
        </div>
      </form>
    </QCard>

    <QCard flush title="发送记录" description="只记这次打开页面以来的">
      <p v-if="!log.length" class="px-4 py-10 text-center text-xs text-fg-muted">还没有发过消息。</p>
      <TransitionGroup v-else tag="ul" name="list" class="divide-y divide-border">
        <li v-for="e in log" :key="e.at" class="flex flex-col gap-1 px-4 py-3">
          <div class="flex items-center justify-between gap-3">
            <StatusDot :tone="e.ok ? 'success' : 'danger'" :label="e.target" class="min-w-0 font-mono text-xs" />
            <span class="shrink-0 text-xs text-fg-subtle tabular-nums">{{ new Date(e.at).toLocaleTimeString('zh-CN', { hour12: false }) }}</span>
          </div>
          <p class="truncate text-sm text-fg">{{ e.text }}</p>
          <p class="text-xs break-words" :class="e.ok ? 'text-fg-muted' : 'text-danger'">{{ e.detail }}</p>
        </li>
      </TransitionGroup>
    </QCard>
  </div>
</template>
