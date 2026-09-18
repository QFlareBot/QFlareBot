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

watch(
  pagePath,
  async (path) => {
    src.value = ''
    if (!path || !plugin.value) return
    try {
      firstToken = (await api.bridgeToken(plugin.value.name)).token
      src.value = `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(firstToken)}`
    } catch (e) {
      push(`无法打开插件页面：${(e as Error).message}`, 'error')
    }
  },
  { immediate: true },
)

function mount() {
  host?.destroy()
  host = null
  if (!frame.value || !plugin.value) return
  host = attachBridgeHost({
    iframe: frame.value,
    plugin: plugin.value.name,
    base: `/p/${plugin.value.name}`,
    theme: theme.value,
    getToken: async () => {
      if (firstToken) {
        const t = firstToken
        firstToken = null
        return t
      }
      return (await api.bridgeToken(plugin.value!.name)).token
    },
    onResize: (h) => (height.value = Math.max(240, Math.min(4000, h))),
    onToast: (level, message) => push(message, level),
    onNavigate: (to) => void router.push(to),
    onTitle: (t) => (title.value = t),
  })
}

watch([frame, plugin], mount)
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
        <a :href="pagePath" target="_blank" rel="noopener"><QButton size="sm" variant="ghost"><ExternalLink class="size-3.5" aria-hidden="true" />新窗口打开</QButton></a>
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
