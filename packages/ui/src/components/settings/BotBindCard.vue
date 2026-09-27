<script setup lang="ts">
/** 扫码创建机器人（协议同 AstrBot）：手机 QQ 扫码即新建机器人，凭证由 Worker 解密验证后直接保存 */
import { QrCode } from 'lucide-vue-next'
import { computed, onBeforeUnmount, ref } from 'vue'
import { renderSVG } from 'uqr'
import { api } from '../../api/client.js'
import { useStatus } from '../../composables/useStatus.js'
import { useToast } from '../../composables/useToast.js'
import QButton from '../ui/QButton.vue'
import QCard from '../ui/QCard.vue'
import QCollapse from '../ui/QCollapse.vue'

const emit = defineEmits<{ created: [] }>()
const { status, refresh } = useStatus()
const { push } = useToast()

type BindState = 'idle' | 'starting' | 'pending' | 'expired' | 'created' | 'error'
const state = ref<BindState>('idle')
const qr = ref('')
const error = ref('')
const origin = location.origin
/** QQ 开放平台访问不到 *.workers.dev，从默认域名打开时不能把它当回调地址给出去 */
const onWorkersDev = location.hostname.endsWith('.workers.dev')
const fromSecret = computed(() => status.value?.bot?.source === 'secret')
let timer: ReturnType<typeof setTimeout> | undefined

function stop() {
  clearTimeout(timer)
  timer = undefined
}
onBeforeUnmount(stop)

async function start() {
  stop()
  state.value = 'starting'
  error.value = ''
  qr.value = ''
  try {
    const task = await api.startBotBind()
    qr.value = renderSVG(task.qrUrl, { border: 1 })
    state.value = 'pending'
    const poll = async () => {
      try {
        const res = await api.pollBotBind(task.taskId, task.key)
        if (res.status === 'pending') {
          timer = setTimeout(poll, 2000)
          return
        }
        state.value = res.status
        if (res.status === 'created') {
          await refresh()
          emit('created')
          push('机器人已创建，凭证已保存并验证通过', 'success')
        }
      } catch (e) {
        state.value = 'error'
        error.value = (e as Error).message
      }
    }
    timer = setTimeout(poll, 2000)
  } catch (e) {
    state.value = 'error'
    error.value = (e as Error).message
  }
}
</script>

<template>
  <QCard title="扫码创建机器人" description="用手机 QQ 扫码就能新建一个机器人，凭证自动保存，不用去开放平台手抄">
    <template #actions>
      <QButton size="sm" :loading="state === 'starting'" :disabled="fromSecret || state === 'pending'" @click="start">
        <QrCode class="size-3.5" aria-hidden="true" />{{ state === 'idle' ? '获取二维码' : '重新获取' }}
      </QButton>
    </template>
    <QCollapse :open="state !== 'idle'">
      <div class="flex flex-col items-start gap-4 sm:flex-row">
        <!-- eslint-disable-next-line vue/no-v-html -- SVG 由 uqr 本地生成 -->
        <div v-if="qr && state !== 'created'" class="size-36 shrink-0 rounded-lg bg-white p-1.5 transition-opacity" :class="{ 'opacity-30': state === 'expired' }" v-html="qr" />
        <div class="flex flex-col gap-2 text-sm" role="status">
          <p v-if="state === 'starting'" class="text-fg-muted">正在获取二维码…</p>
          <template v-else-if="state === 'pending'">
            <p class="flex items-center gap-2 font-medium text-fg"><span class="qb-pulse size-2 rounded-full bg-accent" aria-hidden="true" />等待手机 QQ 扫码</p>
            <p class="text-xs text-fg-muted">扫码确认后会新建一个 QQ 机器人，AppID 与 AppSecret 自动保存。二维码约 3 分钟内有效。</p>
          </template>
          <p v-else-if="state === 'expired'" class="text-fg">二维码已过期，点右上角重新获取。</p>
          <template v-else-if="state === 'created'">
            <p class="font-medium text-fg">机器人已创建，凭证已保存</p>
            <p v-if="onWorkersDev" class="text-xs text-fg-muted">
              还差两步：先给这个 Worker 绑定自定义域名（QQ 开放平台访问不到 <code class="font-mono">*.workers.dev</code>），再到
              <a class="underline" href="https://q.qq.com" target="_blank" rel="noopener">QQ 开放平台</a> 的机器人管理里把回调地址填成
              <code class="font-mono">https://你的域名{{ status?.webhookPath ?? '/webhook' }}</code>
            </p>
            <p v-else class="text-xs text-fg-muted">
              还差一步：到 <a class="underline" href="https://q.qq.com" target="_blank" rel="noopener">QQ 开放平台</a> 的机器人管理里，把回调地址填成
              <code class="font-mono">{{ origin }}{{ status?.webhookPath ?? '/webhook' }}</code>
            </p>
          </template>
          <p v-else-if="state === 'error'" class="text-danger">{{ error }}</p>
        </div>
      </div>
    </QCollapse>
  </QCard>
</template>
