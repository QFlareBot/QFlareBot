<script setup lang="ts">
/** 模态对话框：遮罩、Esc 与点遮罩关闭、焦点困在里面、关掉后焦点回到打开它的元素 */
import { nextTick, ref, toRef, watch } from 'vue'
import { useScrollLock } from '../../composables/useScrollLock.js'
import { focusFirst, trapTab } from '../../lib/focusTrap.js'

const props = withDefaults(defineProps<{ open: boolean; labelledby?: string; describedby?: string; role?: 'dialog' | 'alertdialog' }>(), { role: 'dialog' })
const emit = defineEmits<{ close: [] }>()

const panel = ref<HTMLElement | null>(null)
let opener: HTMLElement | null = null

useScrollLock(toRef(props, 'open'))

watch(
  () => props.open,
  async (open) => {
    if (open) {
      opener = document.activeElement as HTMLElement | null
      await nextTick()
      if (panel.value) focusFirst(panel.value)
    } else if (opener?.isConnected) {
      opener.focus({ preventScroll: true })
      opener = null
    }
  },
)

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    emit('close')
  } else if (panel.value) trapTab(e, panel.value)
}
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog" :duration="{ enter: 480, leave: 200 }">
      <div
        v-if="open"
        class="fixed inset-0 z-50 grid place-items-center bg-overlay p-4 backdrop-blur-[6px]"
        @mousedown.self="emit('close')"
        @keydown="onKeydown"
      >
        <div
          ref="panel"
          :role="role"
          aria-modal="true"
          :aria-labelledby="labelledby"
          :aria-describedby="describedby"
          tabindex="-1"
          class="qb-dialog max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-xl border border-card-border bg-surface p-5 shadow-overlay outline-none"
        >
          <slot />
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
