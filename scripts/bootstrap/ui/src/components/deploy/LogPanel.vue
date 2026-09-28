<script setup lang="ts">
/** 构建与部署的输出（已打码）；展开时跟着滚到底，用户往上翻了就不再抢滚动 */
import QCollapse from '@panel/components/ui/QCollapse.vue'
import { ChevronDown, TerminalSquare } from 'lucide-vue-next'
import { nextTick, ref, watch } from 'vue'
import StepCard from '../base/StepCard.vue'

const props = defineProps<{ lines: string[]; defaultOpen?: boolean }>()
const open = ref(!!props.defaultOpen)
const box = ref<HTMLElement | null>(null)
let follow = true

function onScroll() {
  const el = box.value
  if (el) follow = el.scrollHeight - el.scrollTop - el.clientHeight < 24
}

watch(
  [() => props.lines.length, open],
  async () => {
    await nextTick()
    if (box.value && open.value && follow) box.value.scrollTop = box.value.scrollHeight
  },
  { immediate: true },
)
watch(
  () => props.defaultOpen,
  (v) => v && (open.value = true),
)
</script>

<template>
  <StepCard>
    <button type="button" class="flex w-full cursor-pointer items-center gap-3 text-left" :aria-expanded="open" @click="open = !open">
      <TerminalSquare class="size-4 shrink-0 text-fg-muted" aria-hidden="true" />
      <span class="min-w-0 flex-1">
        <span class="block text-sm font-semibold text-fg">详细日志</span>
        <span class="block text-xs text-fg-muted">构建与部署的输出，出错时看这里是哪一步。</span>
      </span>
      <span v-if="lines.length" class="rounded-full bg-surface-muted px-2 py-0.5 text-xs text-fg-muted tabular-nums">{{ lines.length }} 行</span>
      <ChevronDown class="size-4 shrink-0 text-fg-muted transition-transform duration-(--qb-duration-slow)" :class="open && 'rotate-180'" aria-hidden="true" />
    </button>
    <QCollapse :open="open">
      <pre
        ref="box"
        class="mt-4 max-h-80 overflow-auto rounded-md border border-border bg-surface-muted p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-fg-muted"
        @scroll="onScroll"
      >{{ lines.length ? lines.join('\n') : '构建开始后，这里会显示输出。' }}</pre>
    </QCollapse>
  </StepCard>
</template>
