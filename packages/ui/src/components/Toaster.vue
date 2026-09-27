<script setup lang="ts">
import { CheckCircle2, CircleAlert, Info, TriangleAlert, X } from 'lucide-vue-next'
import { useToast } from '../composables/useToast.js'

const { toasts, dismiss } = useToast()
const icons = { info: Info, success: CheckCircle2, warning: TriangleAlert, error: CircleAlert }
const tones = { info: 'text-fg-muted', success: 'text-success', warning: 'text-warning', error: 'text-danger' }
const bars = { info: 'bg-fg-subtle', success: 'bg-success', warning: 'bg-warning', error: 'bg-danger' }
</script>

<template>
  <div
    class="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+60px)] z-50 flex flex-col items-center gap-2 px-4 md:top-auto md:bottom-4 md:items-end"
    role="status"
    aria-live="polite"
  >
    <!-- 手机放在顶栏下面：浏览器的底部工具栏会挡住贴底的东西 -->
    <TransitionGroup name="toast">
      <div
        v-for="t in toasts"
        :key="t.id"
        class="pointer-events-auto relative flex w-full max-w-sm items-start gap-2 overflow-hidden rounded-lg border border-card-border bg-surface py-2.5 pr-2.5 pl-3 text-sm text-fg shadow-overlay"
      >
        <component :is="icons[t.level]" class="mt-0.5 size-4 shrink-0" :class="tones[t.level]" aria-hidden="true" />
        <span class="min-w-0 flex-1 break-words">{{ t.message }}</span>
        <button type="button" class="-my-0.5 flex size-6 cursor-pointer items-center justify-center rounded-full text-fg-muted hover:bg-surface-muted hover:text-fg" aria-label="关闭" @click="dismiss(t.id)">
          <X class="size-3.5" aria-hidden="true" />
        </button>
        <span
          class="absolute inset-x-0 bottom-0 h-0.5 origin-left opacity-50 [animation:qb-shrink_linear_forwards]"
          :class="bars[t.level]"
          :style="{ animationDuration: `${t.duration}ms` }"
          aria-hidden="true"
        />
      </div>
    </TransitionGroup>
  </div>
</template>
