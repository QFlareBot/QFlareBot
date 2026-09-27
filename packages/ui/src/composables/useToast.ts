import { readonly, ref } from 'vue'

export type ToastLevel = 'info' | 'success' | 'warning' | 'error'
export interface Toast {
  id: number
  level: ToastLevel
  message: string
  /** 停留多久（毫秒），toast 底边的进度条按它走 */
  duration: number
}

/** 同时最多摆几条：一次操作连报好几条时，最早的先让位 */
const MAX_TOASTS = 4

const toasts = ref<Toast[]>([])
let seq = 0

export function useToast() {
  return {
    toasts: readonly(toasts),
    push(message: string, level: ToastLevel = 'info') {
      const id = ++seq
      const duration = level === 'error' ? 6000 : 3000
      toasts.value = [...toasts.value.slice(-(MAX_TOASTS - 1)), { id, level, message, duration }]
      setTimeout(() => dismiss(id), duration)
    },
    dismiss,
  }
}

function dismiss(id: number) {
  toasts.value = toasts.value.filter((t) => t.id !== id)
}
