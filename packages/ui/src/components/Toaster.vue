<script setup lang="ts">
import { CheckCircle2, CircleAlert, Info, TriangleAlert, X } from 'lucide-vue-next'
import { useToast } from '../composables/useToast.js'

const { toasts, dismiss } = useToast()
const icons = { info: Info, success: CheckCircle2, warning: TriangleAlert, error: CircleAlert }
</script>

<template>
  <div class="pointer-events-none fixed inset-x-0 bottom-16 z-50 flex flex-col items-center gap-2 px-4 md:bottom-4 md:items-end" role="status" aria-live="polite">
    <TransitionGroup name="fade">
      <div
        v-for="t in toasts"
        :key="t.id"
        class="pointer-events-auto flex max-w-sm items-start gap-2 rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg shadow-(--qb-shadow)"
      >
        <component
          :is="icons[t.level]"
          class="mt-0.5 size-4 shrink-0"
          :class="{ info: 'text-fg-muted', success: 'text-success', warning: 'text-warning', error: 'text-danger' }[t.level]"
          aria-hidden="true"
        />
        <span class="min-w-0 flex-1 break-words">{{ t.message }}</span>
        <button type="button" class="-m-1 flex size-6 cursor-pointer items-center justify-center rounded-sm text-fg-muted hover:text-fg" aria-label="关闭" @click="dismiss(t.id)">
          <X class="size-3.5" aria-hidden="true" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>
