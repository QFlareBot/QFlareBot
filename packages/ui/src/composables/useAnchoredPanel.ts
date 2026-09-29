/**
 * 浮层贴着触发元素摆：默认在下方，下方放不下且上方更宽裕就翻到上方；
 * 打开期间页面滚动（任何一层滚动容器）、窗口缩放都跟着重新算。浮层本身挂在 body 上用 fixed 定位，
 * 这样卡片、对话框的 overflow 裁不到它。
 */
import { onBeforeUnmount, ref, watch, type Ref } from 'vue'

const GAP = 4
const MARGIN = 8
/** 浮层最高多少：再高就在里面滚动 */
const MAX_HEIGHT = 288
/** 下方至少留这么高才放下方 */
const MIN_BELOW = 160

export function useAnchoredPanel(anchor: Ref<HTMLElement | null>, open: Ref<boolean>) {
  const style = ref<Record<string, string>>({})
  const placement = ref<'bottom' | 'top'>('bottom')

  function update() {
    const el = anchor.value
    if (!el) return
    const r = el.getBoundingClientRect()
    const vw = document.documentElement.clientWidth
    const vh = window.innerHeight
    const below = vh - r.bottom - GAP - MARGIN
    const above = r.top - GAP - MARGIN
    const up = below < MIN_BELOW && above > below
    placement.value = up ? 'top' : 'bottom'
    const left = Math.max(MARGIN, Math.min(r.left, vw - MARGIN - r.width))
    style.value = {
      left: `${left}px`,
      minWidth: `${Math.min(r.width, vw - 2 * MARGIN)}px`,
      maxWidth: `${vw - left - MARGIN}px`,
      maxHeight: `${Math.max(0, Math.min(MAX_HEIGHT, up ? above : below))}px`,
      ...(up ? { bottom: `${vh - r.top + GAP}px` } : { top: `${r.bottom + GAP}px` }),
    }
  }

  function listen(on: boolean) {
    const method = on ? 'addEventListener' : 'removeEventListener'
    window[method]('scroll', update, { capture: true, passive: true } as AddEventListenerOptions)
    window[method]('resize', update)
  }

  watch(open, (o) => {
    if (o) update()
    listen(o)
  })
  onBeforeUnmount(() => listen(false))

  return { style, placement, update }
}
