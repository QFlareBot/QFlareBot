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

/** 全局共享的状态快照；页面按需开启轮询 */
export function useStatus(options: { pollMs?: number } = {}) {
  if (options.pollMs) {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, options.pollMs)
    onScopeDispose(() => clearInterval(timer))
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
