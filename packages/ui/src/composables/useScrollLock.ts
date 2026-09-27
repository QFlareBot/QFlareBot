import { onScopeDispose, watch, type Ref } from 'vue'

/** 同时开着几层浮层（抽屉里点开对话框）时，最后一层关掉才恢复滚动 */
let locks = 0

function lock() {
  if (locks++ === 0) document.documentElement.style.overflow = 'hidden'
}
function unlock() {
  if (locks > 0 && --locks === 0) document.documentElement.style.overflow = ''
}

/** 浮层打开期间禁止页面滚动 */
export function useScrollLock(active: Ref<boolean>): void {
  let held = false
  const set = (on: boolean) => {
    if (on === held) return
    held = on
    if (on) lock()
    else unlock()
  }
  watch(active, set, { immediate: true })
  onScopeDispose(() => set(false))
}
