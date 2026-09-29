/**
 * 离开页面前提醒没保存的修改。页面调 provideUnsavedGuard() 装一次守卫，页面里的各张卡片用 trackUnsaved() 登记自己的「改过没有」：
 * 一页几张卡片都改了也只问一次。
 * 站内跳转用面板自己的确认框；关标签页、刷新只能用浏览器自带的提示（浏览器不让页面自己画）。
 */
import { inject, onBeforeUnmount, onMounted, provide, type InjectionKey } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import { useConfirm } from './useConfirm.js'

const KEY: InjectionKey<Set<() => boolean>> = Symbol('unsaved')

export function provideUnsavedGuard(): void {
  const checks = new Set<() => boolean>()
  provide(KEY, checks)
  const confirm = useConfirm()
  const dirty = () => [...checks].some((c) => c())

  async function guard(): Promise<boolean> {
    if (!dirty()) return true
    const ok = await confirm({ title: '有修改还没保存', message: '离开后这些修改会丢掉。', confirmText: '不保存，离开', cancelText: '留下', danger: true })
    return !!ok
  }
  onBeforeRouteLeave(guard)
  // 从一个插件的详情页跳到另一个插件：同一个页面组件复用，走的是 update
  onBeforeRouteUpdate((to, from) => (to.path === from.path ? true : guard()))

  function onBeforeUnload(e: BeforeUnloadEvent) {
    if (!dirty()) return
    e.preventDefault()
    e.returnValue = ''
  }
  onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))
  onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload))
}

/** 卡片里调：dirty 返回 true 表示有没保存的修改。不在守卫下面（别的页面复用这张卡片）时什么也不做 */
export function trackUnsaved(dirty: () => boolean): void {
  const checks = inject(KEY, null)
  if (!checks) return
  checks.add(dirty)
  onBeforeUnmount(() => checks.delete(dirty))
}
