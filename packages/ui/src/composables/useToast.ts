import { readonly, ref } from 'vue'

export type ToastLevel = 'info' | 'success' | 'warning' | 'error'
export interface Toast {
  id: number
  level: ToastLevel
  message: string
}

const toasts = ref<Toast[]>([])
let seq = 0

export function useToast() {
  return {
    toasts: readonly(toasts),
    push(message: string, level: ToastLevel = 'info') {
      const id = ++seq
      toasts.value.push({ id, level, message })
      setTimeout(() => dismiss(id), level === 'error' ? 6000 : 3000)
    },
    dismiss,
  }
}

function dismiss(id: number) {
  toasts.value = toasts.value.filter((t) => t.id !== id)
}
