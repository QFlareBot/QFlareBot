<script setup lang="ts">
/** 分享链接：别人点开或用手机 QQ 扫码，就能直接打开和机器人的会话 */
import { Check, Copy, Link } from 'lucide-vue-next'
import { ref } from 'vue'
import { renderSVG } from 'uqr'
import { api } from '../../api/client.js'
import { useToast } from '../../composables/useToast.js'
import { explainPlatformError } from '../../lib/qqPanel.js'
import QButton from '../ui/QButton.vue'
import QCard from '../ui/QCard.vue'
import QCollapse from '../ui/QCollapse.vue'

const { push } = useToast()
const busy = ref(false)
const link = ref('')
const qr = ref('')
const failure = ref('')
const copied = ref(false)

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
  navigator.clipboard.writeText(link.value).then(
    () => {
      copied.value = true
      setTimeout(() => (copied.value = false), 1600)
    },
    () => push('浏览器不让写剪贴板，请手动选中复制', 'warning'),
  )
}
</script>

<template>
  <QCard title="分享链接" description="想把机器人推荐给别人用时才需要：点开或用手机 QQ 扫码，就能直接打开和它的会话">
    <template #actions>
      <QButton size="sm" :loading="busy" @click="generate"><Link class="size-3.5" aria-hidden="true" />{{ link ? '重新生成' : '生成链接' }}</QButton>
    </template>
    <p v-if="failure" class="text-sm text-danger" role="alert">{{ failure }}</p>
    <QCollapse :open="!!link">
      <div class="flex flex-col gap-3 sm:flex-row sm:items-start">
        <!-- eslint-disable-next-line vue/no-v-html -- SVG 由 uqr 本地生成 -->
        <div class="size-36 shrink-0 rounded-lg bg-white p-1.5" v-html="qr" />
        <div class="flex min-w-0 flex-1 flex-col gap-2">
          <code class="rounded-md bg-surface-muted px-3 py-2 font-mono text-xs break-all text-fg">{{ link }}</code>
          <div>
            <QButton size="sm" :class="copied && 'text-success'" @click="copy">
              <Check v-if="copied" class="qb-pop size-3.5" aria-hidden="true" /><Copy v-else class="size-3.5" aria-hidden="true" />
              <span aria-live="polite">{{ copied ? '已复制' : '复制' }}</span>
            </QButton>
          </div>
        </div>
      </div>
    </QCollapse>
  </QCard>
</template>
