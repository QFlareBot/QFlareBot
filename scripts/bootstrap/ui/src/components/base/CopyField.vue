<script setup lang="ts">
/** 一段要照抄的文字（命令、地址）：等宽显示、可以整段折行，右边一键复制 */
import { Check, Copy } from 'lucide-vue-next'
import { ref } from 'vue'
import { useCopy } from '../../composables/useCopy.js'

const props = defineProps<{ value: string; label?: string }>()
const code = ref<HTMLElement | null>(null)
const { copied, copy } = useCopy()
</script>

<template>
  <div class="min-w-0">
    <p v-if="label" class="mb-1 text-xs text-fg-muted">{{ label }}</p>
    <div class="flex min-w-0 items-center gap-2 rounded-md border border-border bg-surface-muted py-1.5 pr-1.5 pl-3">
      <code ref="code" class="min-w-0 flex-1 font-mono text-xs leading-relaxed wrap-anywhere text-fg">{{ value }}</code>
      <button
        type="button"
        class="flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-full px-2.5 text-xs font-medium transition-[background-color,color,transform] duration-(--qb-duration) hover:bg-surface active:scale-95"
        :class="copied ? 'text-success' : 'text-fg-muted hover:text-fg'"
        :aria-label="label ? `复制${label}` : '复制'"
        @click="copy(props.value, code)"
      >
        <Transition name="swap" type="transition" mode="out-in">
          <Check v-if="copied" key="done" class="size-3.5" aria-hidden="true" />
          <Copy v-else key="copy" class="size-3.5" aria-hidden="true" />
        </Transition>
        <span aria-live="polite">{{ copied ? '已复制' : '复制' }}</span>
      </button>
    </div>
  </div>
</template>
