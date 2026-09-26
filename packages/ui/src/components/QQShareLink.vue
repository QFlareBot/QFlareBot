<script setup lang="ts">
import { Copy } from 'lucide-vue-next'
import { ref } from 'vue'
import { renderSVG } from 'uqr'
import { api } from '../api/client.js'
import { useToast } from '../composables/useToast.js'
import { explainPlatformError } from '../lib/qqPanel.js'
import QButton from './ui/QButton.vue'
import QCard from './ui/QCard.vue'

const { push } = useToast()
const busy = ref(false)
const link = ref('')
const qr = ref('')
const failure = ref('')

/** 平台响应是 { retcode, msg, data: { url } }，老一些的写法 url 直接在最外层 */
function pickUrl(data: unknown): string {
  const d = (data ?? {}) as { url?: unknown; data?: { url?: unknown } }
  const url = d.data?.url ?? d.url
  return typeof url === 'string' ? url : ''
}

async function generate() {
  busy.value = true
  failure.value = ''
  try {
    const res = await api.createUrlLink({})
    const url = res.ok ? pickUrl(res.data) : ''
    if (!url) {
      failure.value = res.ok ? '平台没返回链接' : explainPlatformError(res.status, res.data)
      return
    }
    link.value = url
    qr.value = renderSVG(url, { border: 1 })
  } catch (e) {
    failure.value = (e as Error).message
  } finally {
    busy.value = false
  }
}

function copy() {
  void navigator.clipboard.writeText(link.value).then(() => push('已复制链接', 'success'))
}
</script>

<template>
  <QCard title="分享链接" description="别人点开或用手机 QQ 扫码，就能直接打开和机器人的会话；想把机器人推荐给别人用时才需要">
    <div class="flex flex-col gap-3">
      <div><QButton variant="primary" :loading="busy" @click="generate">{{ link ? '重新生成' : '生成链接' }}</QButton></div>
      <p v-if="failure" class="text-sm text-danger" role="alert">{{ failure }}</p>
      <div v-if="link" class="flex flex-col gap-3 sm:flex-row sm:items-start">
        <!-- eslint-disable-next-line vue/no-v-html -- SVG 由 uqr 本地生成 -->
        <div class="size-36 shrink-0 rounded-md bg-white p-1" v-html="qr" />
        <div class="flex min-w-0 flex-1 flex-col gap-2">
          <code class="break-all rounded-md bg-surface-muted px-2 py-1.5 font-mono text-xs text-fg">{{ link }}</code>
          <div><QButton size="sm" @click="copy"><Copy class="size-3.5" aria-hidden="true" />复制</QButton></div>
        </div>
      </div>
    </div>
  </QCard>
</template>
