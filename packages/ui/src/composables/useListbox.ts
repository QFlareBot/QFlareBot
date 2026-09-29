/**
 * 下拉选择的键盘操作（照 WAI-ARIA 的 select-only combobox）：焦点一直留在触发按钮上，
 * 高亮项靠 aria-activedescendant 告诉读屏。
 * 收起时：上下键、回车、空格打开；Home / End 打开并跳到头尾；敲字母打开并跳到匹配项。
 * 打开时：上下键、PageUp / PageDown、Home / End 移动高亮；回车、空格选中；Esc、Tab 收起不改值。
 */
import { ref, type Ref } from 'vue'

interface Options {
  open: Ref<boolean>
  labels: () => string[]
  /** 当前选中项的下标，没有选中为 -1 */
  selected: () => number
  choose: (index: number) => void
}

const PAGE = 8

export function useListbox({ open, labels, selected, choose }: Options) {
  const active = ref(-1)
  let typed = ''
  let typedAt = 0

  const last = () => labels().length - 1
  const clamp = (i: number) => Math.max(0, Math.min(last(), i))

  function show(at = selected()) {
    active.value = clamp(at < 0 ? 0 : at)
    open.value = true
  }
  function hide() {
    open.value = false
  }

  /** 连着敲的字拼起来匹配；同一个字母连敲就在以它开头的几项之间轮换 */
  function typeahead(ch: string): number {
    const now = Date.now()
    typed = now - typedAt < 600 ? typed + ch : ch
    typedAt = now
    const all = labels().map((l) => l.toLowerCase())
    const repeat = typed.length > 1 && [...typed].every((c) => c === typed[0])
    const needle = repeat ? typed[0]! : typed
    const from = active.value + (needle.length === 1 ? 1 : 0)
    for (let k = 0; k < all.length; k++) {
      const i = (from + k) % all.length
      if (all[i]!.startsWith(needle)) return i
    }
    return -1
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.isComposing) return
    const key = e.key
    const printable = key.length === 1 && key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey

    if (!open.value) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(key)) show()
      else if (key === 'Home') show(0)
      else if (key === 'End') show(last())
      else if (printable) {
        active.value = selected()
        const i = typeahead(key.toLowerCase())
        show(i < 0 ? selected() : i)
      } else return
      e.preventDefault()
      return
    }

    if (key === 'ArrowDown') active.value = clamp(active.value + 1)
    else if (key === 'ArrowUp' && e.altKey) choose(active.value)
    else if (key === 'ArrowUp') active.value = clamp(active.value - 1)
    else if (key === 'PageDown') active.value = clamp(active.value + PAGE)
    else if (key === 'PageUp') active.value = clamp(active.value - PAGE)
    else if (key === 'Home') active.value = 0
    else if (key === 'End') active.value = last()
    else if (key === 'Enter' || key === ' ') choose(active.value)
    else if (key === 'Escape') {
      // 别让外面的对话框也跟着关掉
      e.stopPropagation()
      hide()
    } else if (key === 'Tab') {
      hide()
      return
    } else if (printable) {
      const i = typeahead(key.toLowerCase())
      if (i >= 0) active.value = i
    } else return
    e.preventDefault()
  }

  return { active, show, hide, onKeydown }
}
