/**
 * 插件页的构建状态：D1 清单与线上的对照、构建记录、有构建在跑时的轮询、重新构建。
 * 每个页面调用一次，自带定时器，页面卸载时停掉。
 */
import { computed, onMounted, onScopeDispose, ref, watch } from 'vue'
import { api } from '../api/client.js'
import type { InstallRecord, ManagedPlugin, ManagedPluginsResult, PluginInfo } from '../api/types.js'
import { pendingChanges } from '../lib/pendingChanges.js'
import { useStatus } from './useStatus.js'
import { useToast } from './useToast.js'

/** 构建是分钟级的，5 秒一次足够，也不至于把面板变成压测工具 */
const BUILD_POLL_MS = 5000

export function useBuildState() {
  const { refresh } = useStatus()
  const { push } = useToast()

  const managed = ref<ManagedPluginsResult | null>(null)
  const managedByName = computed(() => new Map((managed.value?.plugins ?? []).map((p) => [p.name, p])))
  const changes = computed(() => pendingChanges(managed.value))

  /** 拉不到（未绑定 D1、老版本 Worker）就当没有：面板其余部分照常能用 */
  async function refreshManaged(): Promise<void> {
    try {
      managed.value = await api.managedPlugins()
    } catch {
      managed.value = null
    }
  }
  const managedOf = (p: PluginInfo): ManagedPlugin | undefined => managedByName.value.get(p.name)

  // —— 构建记录：默认折叠，展开即拉取 ——
  const buildsOpen = ref(false)
  const builds = ref<InstallRecord[]>([])
  const buildsLoading = ref(false)
  const buildsSyncError = ref('')
  /** 拉取本身失败（网络/服务端），与 buildsSyncError（服务端说同步不了）分开提示，免得套错排查建议 */
  const buildsFetchError = ref('')

  /** silent=true 用于轮询：不点亮按钮上的 loading，否则每 5 秒闪一次 */
  async function refreshBuilds(silent = false) {
    if (!silent) buildsLoading.value = true
    try {
      const res = await api.builds()
      builds.value = res.builds
      buildsSyncError.value = res.syncError ?? ''
      buildsFetchError.value = ''
    } catch {
      if (!silent) buildsFetchError.value = '拉取构建记录失败（网络或服务端错误）'
    } finally {
      if (!silent) buildsLoading.value = false
    }
  }

  function toggleBuilds() {
    buildsOpen.value = !buildsOpen.value
    if (buildsOpen.value) void refreshBuilds()
  }

  async function refreshAll(): Promise<void> {
    await Promise.all([refresh(), refreshManaged(), buildsOpen.value ? refreshBuilds(true) : Promise.resolve()])
  }

  // —— 有构建在跑就轮询到结束，结束时刷新插件列表（线上换了版本） ——
  const building = computed(() => !!managed.value?.building || builds.value.some((b) => b.status === 'building'))
  let timer: ReturnType<typeof setInterval> | null = null

  /** 拉构建记录会顺带向 Cloudflare 同步状态，所以先拉它、再看对照表 */
  async function pollTick() {
    await refreshBuilds(true)
    await refreshManaged()
  }

  watch(building, (on, was) => {
    if (on) timer ??= setInterval(() => void pollTick(), BUILD_POLL_MS)
    else if (timer) {
      clearInterval(timer)
      timer = null
    }
    if (was && !on) void refresh()
  })
  onMounted(() => void refreshManaged())
  onScopeDispose(() => {
    if (timer) clearInterval(timer)
  })

  // —— 重新构建：重试失败的构建 ——
  const rebuilding = ref(false)
  async function rebuild() {
    rebuilding.value = true
    try {
      await api.triggerBuild()
      push('已触发重新构建，完成后插件自动上线', 'success')
    } catch (e) {
      push(`触发构建失败：${(e as Error).message}`, 'error')
    } finally {
      rebuilding.value = false
    }
    await refreshBuilds(!buildsOpen.value)
    void refreshManaged()
  }

  return {
    managed,
    managedOf,
    changes,
    building,
    builds,
    buildsOpen,
    buildsLoading,
    buildsSyncError,
    buildsFetchError,
    toggleBuilds,
    refreshManaged,
    refreshAll,
    rebuilding,
    rebuild,
  }
}

export type BuildState = ReturnType<typeof useBuildState>
