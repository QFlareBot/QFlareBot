import { onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue'
import { api } from '../api.js'
import type { ExistingInfo } from '../types.js'

/**
 * 第 ② 步：这个名字的 Worker 部署过没有。改名字时停下 600ms 再查，只认最后一次的结果。
 * 查不到（网络、权限）就当不知道，不拦部署——部署时 runBootstrap 自己还会再查一次。
 */
export function useExisting(workerName: Ref<string>) {
  const info = shallowRef<ExistingInfo | null>(null)
  const checking = ref(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  let seq = 0

  async function check(name: string) {
    const id = ++seq
    checking.value = true
    try {
      const res = await api.existing(name)
      if (id === seq) info.value = res
    } catch {
      if (id === seq) info.value = null
    } finally {
      if (id === seq) checking.value = false
    }
  }

  watch(
    workerName,
    (name, old) => {
      clearTimeout(timer)
      info.value = null
      if (old === undefined) void check(name)
      else timer = setTimeout(() => void check(name), 600)
    },
    { immediate: true },
  )
  onScopeDispose(() => clearTimeout(timer))

  return { info, checking }
}
