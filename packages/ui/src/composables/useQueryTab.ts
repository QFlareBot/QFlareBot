import { computed, type WritableComputedRef } from 'vue'
import { useRoute, useRouter } from 'vue-router'

/**
 * 页内标签记在地址的查询参数里：刷新、分享链接、前进后退都停在同一个标签。
 * 默认标签不写进地址，保持链接干净。
 */
export function useQueryTab<T extends string>(key: string, values: readonly T[], fallback: T): WritableComputedRef<T> {
  const route = useRoute()
  const router = useRouter()
  return computed<T>({
    get: () => {
      const v = String(route.query[key] ?? '')
      return (values as readonly string[]).includes(v) ? (v as T) : fallback
    },
    set: (v) => void router.replace({ query: { ...route.query, [key]: v === fallback ? undefined : v } }),
  })
}
