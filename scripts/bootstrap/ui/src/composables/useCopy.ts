import { onScopeDispose, ref } from 'vue'

/** 复制到剪贴板；剪贴板不可用（非安全上下文等）时退回选中文本，让用户自己 Ctrl+C */
export function useCopy() {
  const copied = ref(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  async function copy(text: string, fallback?: HTMLElement | null) {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      if (fallback) getSelection()?.selectAllChildren(fallback)
      return
    }
    copied.value = true
    clearTimeout(timer)
    timer = setTimeout(() => (copied.value = false), 1600)
  }

  onScopeDispose(() => clearTimeout(timer))
  return { copied, copy }
}
