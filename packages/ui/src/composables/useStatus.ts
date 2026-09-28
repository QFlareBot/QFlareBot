import { computed, onScopeDispose, ref } from 'vue'
import { api } from '../api/client.js'
import type { PluginInfo, Status } from '../api/types.js'

const status = ref<Status | null>(null)
const error = ref<string | null>(null)
const loading = ref(false)
const updatedAt = ref(0)
let inflight: Promise<void> | null = null

async function refresh(): Promise<void> {
  if (inflight) return inflight
  loading.value = true
  inflight = api
    .status()
    .then((s) => {
      status.value = s
      error.value = null
      updatedAt.value = Date.now()
    })
    .catch((e: Error) => {
      error.value = e.message
    })
    .finally(() => {
      loading.value = false
      inflight = null
    })
  return inflight
}

/**
 * 全局共享的状态快照；页面按需开启轮询。轮询时切回页面（换回标签页、窗口从最小化恢复）立刻刷新一次，
 * 所以间隔可以放长：状态只在有人操作时才变，面板自己的操作本来就会刷新
 */
export function useStatus(options: { pollMs?: number } = {}) {
  if (options.pollMs) {
    const visible = () => document.visibilityState === 'visible'
    const timer = setInterval(() => {
      if (visible()) void refresh()
    }, options.pollMs)
    const onVisibility = () => {
      if (visible()) void refresh()
    }
    document.addEventListener('visibilitychange', onVisibility)
    onScopeDispose(() => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    })
  }
  if (!status.value && !inflight) void refresh()

  return {
    status,
    error,
    loading,
    updatedAt,
    refresh,
    plugins: computed<PluginInfo[]>(() => status.value?.plugins ?? []),
    pluginByName: (name: string) => status.value?.plugins.find((p) => p.name === name),
    patchLocal(name: string, patch: Partial<PluginInfo>) {
      const p = status.value?.plugins.find((x) => x.name === name)
      if (p) Object.assign(p, patch)
    },
  }
}
