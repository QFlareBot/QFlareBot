/**
 * 还不能保存的字段登记处：JSON 解析不了、映射的键重复……由 SchemaForm 提供，各层字段登记自己的路径。
 * 按组件实例登记而不是按路径：映射里两行键重复时两个值的路径相同，按路径删会把对方的也删掉。
 */
import { computed, inject, onBeforeUnmount, provide, reactive, watchEffect, type ComputedRef, type InjectionKey } from 'vue'

const KEY: InjectionKey<Map<number, string[]>> = Symbol('schema-invalid')
let seq = 0

/** SchemaForm 调：返回去重后的路径，按登记先后排 */
export function provideInvalid(): ComputedRef<string[]> {
  const registry = reactive(new Map<number, string[]>())
  provide(KEY, registry)
  return computed(() => [...new Set([...registry.values()].flat())])
}

/** 字段调：paths 为空表示没问题。数组项上下移时路径会变，跟着改登记 */
export function useInvalid(paths: () => string[]): void {
  const registry = inject(KEY, null)
  if (!registry) return
  const id = ++seq
  watchEffect(() => {
    const list = paths()
    if (list.length) registry.set(id, list)
    else registry.delete(id)
  })
  onBeforeUnmount(() => registry.delete(id))
}
