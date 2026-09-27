/** 对话框、抽屉共用：Tab 在容器里循环，打开时把焦点移进去 */

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement)
}

/** 优先带 data-autofocus 的元素，没有就第一个能聚焦的 */
export function focusFirst(root: HTMLElement): void {
  const target = root.querySelector<HTMLElement>('[data-autofocus]') ?? focusables(root)[0] ?? root
  target.focus({ preventScroll: true })
}

/** 在 keydown 里调用：Tab / Shift+Tab 到头时绕回另一端 */
export function trapTab(e: KeyboardEvent, root: HTMLElement): void {
  if (e.key !== 'Tab') return
  const list = focusables(root)
  if (!list.length) {
    e.preventDefault()
    return
  }
  const first = list[0]!
  const last = list[list.length - 1]!
  const active = document.activeElement
  if (e.shiftKey && (active === first || !root.contains(active))) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && active === last) {
    e.preventDefault()
    first.focus()
  }
}
