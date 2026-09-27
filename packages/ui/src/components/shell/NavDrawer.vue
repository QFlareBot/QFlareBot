<script setup lang="ts">
/** 手机的导航抽屉：从左侧滑入，点遮罩、按 Esc、换页或窗口变宽都会收起 */
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useScrollLock } from '../../composables/useScrollLock.js'
import { focusFirst, trapTab } from '../../lib/focusTrap.js'

const open = defineModel<boolean>('open', { required: true })
const panel = ref<HTMLElement | null>(null)
const route = useRoute()
let opener: HTMLElement | null = null

useScrollLock(open)
watch(() => route.fullPath, () => (open.value = false))

const wide = matchMedia('(min-width: 768px)')
const onWide = (e: MediaQueryListEvent) => e.matches && (open.value = false)
wide.addEventListener('change', onWide)
onBeforeUnmount(() => wide.removeEventListener('change', onWide))

watch(open, async (v) => {
  if (v) {
    opener = document.activeElement as HTMLElement | null
    await nextTick()
    if (panel.value) focusFirst(panel.value)
  } else if (opener?.isConnected) {
    opener.focus({ preventScroll: true })
    opener = null
  }
})

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') open.value = false
  else if (panel.value) trapTab(e, panel.value)
}
</script>

<template>
  <Teleport to="body">
    <Transition name="drawer" :duration="{ enter: 480, leave: 320 }">
      <div v-if="open" class="fixed inset-0 z-40 bg-overlay md:hidden" @mousedown.self="open = false" @keydown="onKeydown">
        <div
          ref="panel"
          role="dialog"
          aria-modal="true"
          aria-label="导航"
          class="qb-drawer qb-glass absolute top-[calc(env(safe-area-inset-top)+0.5rem)] bottom-[calc(env(safe-area-inset-bottom)+0.5rem)] left-[max(0.5rem,env(safe-area-inset-left))] w-[min(18rem,calc(100vw-4rem))] overflow-hidden rounded-[18px] shadow-overlay"
        >
          <slot />
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
