import { onScopeDispose, ref, shallowRef, watch } from 'vue'

export type VerifyStatus = 'idle' | 'checking' | 'ok' | 'error'

/**
 * 粘贴 token 后自动验证：粘贴立即验，手敲的停下 600ms 再验；只认最后一次请求的结果，
 * 前一个还没回来就改了输入，旧结果直接丢掉。
 */
export function useAutoVerify<T>(verify: (value: string) => Promise<T>, { delay = 600 } = {}) {
  const input = ref('')
  const status = ref<VerifyStatus>('idle')
  const result = shallowRef<T | null>(null)
  const error = shallowRef<Error | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined
  let seq = 0

  async function run() {
    clearTimeout(timer)
    const v = input.value.trim()
    const id = ++seq
    result.value = null
    error.value = null
    if (!v) {
      status.value = 'idle'
      return
    }
    status.value = 'checking'
    try {
      const r = await verify(v)
      if (id !== seq) return
      result.value = r
      status.value = 'ok'
    } catch (err) {
      if (id !== seq) return
      error.value = err as Error
      status.value = 'error'
    }
  }

  function schedule(ms = delay) {
    clearTimeout(timer)
    timer = setTimeout(run, ms)
  }

  watch(input, (v) => {
    // 一改输入，上一次的结论就不算数了
    seq++
    result.value = null
    error.value = null
    status.value = 'idle'
    if (v.trim()) schedule()
    else clearTimeout(timer)
  })
  onScopeDispose(() => clearTimeout(timer))

  return {
    input,
    status,
    result,
    error,
    run,
    /** input 的 paste 事件里调：值在 paste 之后的 input 事件里才更新，所以排到下一轮 */
    onPaste: () => schedule(30),
  }
}
