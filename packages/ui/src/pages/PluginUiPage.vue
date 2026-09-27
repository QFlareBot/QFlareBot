<script setup lang="ts">
/** 插件页面宿主：sandbox iframe + 桥接令牌，插件页面与面板同主题 */
import { ArrowLeft, ExternalLink } from 'lucide-vue-next'
import { attachBridgeHost, type BridgeHost } from '@qqbot/ui-bridge/host'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api/client.js'
import PageHeader from '../components/PageHeader.vue'
import QButton from '../components/ui/QButton.vue'
import QEmpty from '../components/ui/QEmpty.vue'
import { useStatus } from '../composables/useStatus.js'
import { useTheme } from '../composables/useTheme.js'
import { useToast } from '../composables/useToast.js'

const route = useRoute()
const router = useRouter()
const { pluginByName, status } = useStatus()
const { theme } = useTheme()
const { push } = useToast()

const name = computed(() => String(route.params.name))
const plugin = computed(() => pluginByName(name.value))
const pagePath = computed(() => (plugin.value?.ui ? `/p/${plugin.value.name}${plugin.value.ui.path}` : ''))
// iframe 的首个请求带不了 Authorization 头，首次令牌走 ?token=，之后由桥刷新
const src = ref('')
const frame = ref<HTMLIFrameElement | null>(null)
const height = ref(480)
const title = ref('')
let host: BridgeHost | null = null

let firstToken: string | null = null
/** 每次换页面加一：只认最后一次请求的令牌 */
let pageSeq = 0

const withToken = (path: string, token: string) => `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`

watch(
  pagePath,
  async (path) => {
    const seq = ++pageSeq
    src.value = ''
    firstToken = null
    if (!path || !plugin.value) return
    try {
      const { token } = await api.bridgeToken(plugin.value.name)
      // 等令牌期间切到了别的插件：A→B→A 快速切换、响应又乱序时，B 的页面会配上 A 的令牌（或反过来）。
      // 只认最后一次请求，比只核对 path 更严：A 的旧响应也不会再把刚打开的 iframe 重载一遍
      if (seq !== pageSeq || pagePath.value !== path) return
      firstToken = token
      src.value = withToken(path, token)
    } catch (e) {
      if (seq !== pageSeq) return
      push(`无法打开插件页面：${(e as Error).message}`, 'error')
    }
  },
  { immediate: true },
)

// 新窗口里没有桥来送令牌，只能像 iframe 首次那样放进 ?token=（1 小时有效，不刷新）。
// 窗口必须在点击里同步打开，等拿到令牌再 open 会被浏览器当成弹窗拦掉
async function openInNewWindow() {
  const path = pagePath.value
  if (!path || !plugin.value) return
  const win = window.open('', '_blank')
  if (!win) {
    push('浏览器拦截了新窗口', 'error')
    return
  }
  win.opener = null
  try {
    win.location.href = withToken(path, (await api.bridgeToken(plugin.value.name)).token)
  } catch (e) {
    win.close()
    push(`无法打开插件页面：${(e as Error).message}`, 'error')
  }
}

function mount() {
  host?.destroy()
  host = null
  if (!frame.value || !plugin.value) return
  const name = plugin.value.name
  host = attachBridgeHost({
    iframe: frame.value,
    plugin: name,
    base: `/p/${name}`,
    theme: theme.value,
    getToken: async () => {
      if (firstToken) {
        const t = firstToken
        firstToken = null
        return t
      }
      return (await api.bridgeToken(name)).token
    },
    onResize: (h) => (height.value = Math.max(240, Math.min(4000, h))),
    onToast: (level, message) => push(message, level),
    onNavigate: (to) => void router.push(to),
    onTitle: (t) => (title.value = t),
  })
}

// 按插件名而不是插件对象：状态一刷新 pluginByName 就返回新对象，重接一次桥会换掉 nonce、丢掉握手，
// 已经握过手的页面不会再发 ready，之后的主题、令牌刷新就都到不了它那里
watch([frame, () => plugin.value?.name], mount)
watch(theme, (t) => host?.setTheme(t))
onBeforeUnmount(() => host?.destroy())
</script>

<template>
  <div>
    <RouterLink :to="`/plugins/${name}`" class="mb-3 inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"><ArrowLeft class="size-4" aria-hidden="true" />{{ plugin?.displayName ?? '插件' }}</RouterLink>
    <QEmpty v-if="status && (!plugin || !plugin.ui)" title="该插件没有页面" />
    <QEmpty v-else-if="plugin && !plugin.enabled" title="插件已禁用" description="启用后才能打开它的页面。" />
    <template v-else-if="plugin">
      <PageHeader :title="title || plugin.ui?.title || plugin.displayName">
        <QButton size="sm" variant="ghost" @click="openInNewWindow"><ExternalLink class="size-3.5" aria-hidden="true" />新窗口打开</QButton>
      </PageHeader>
      <iframe
        v-if="src"
        ref="frame"
        :key="src"
        :src="src"
        :title="plugin.ui?.title ?? plugin.displayName"
        sandbox="allow-scripts allow-forms allow-popups allow-downloads"
        class="block w-full rounded-lg border border-border bg-surface transition-[height] duration-(--qb-duration-slow)"
        :style="{ height: `${height}px` }"
      />
    </template>
  </div>
</template>
