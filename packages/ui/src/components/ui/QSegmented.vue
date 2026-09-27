<script setup lang="ts">
/** 分段切换（页内标签）：选中块跟着滑过去，左右方向键切换；选项多时在窄屏上横向滚动 */
import type { Component } from 'vue'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{
  modelValue: string
  options: Array<{ value: string; label: string; icon?: Component; badge?: string | number }>
  label: string
}>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const root = ref<HTMLElement | null>(null)
const indicator = ref<{ x: number; w: number } | null>(null)
const animate = ref(false)
let observer: ResizeObserver | null = null

const selected = () => root.value?.querySelector<HTMLElement>('[aria-selected="true"]')

function measure() {
  const el = selected()
  indicator.value = el ? { x: el.offsetLeft, w: el.offsetWidth } : null
}

// 窄屏上选项横向滚动时，把新选中的那一项滚进来
watch(
  () => props.modelValue,
  () =>
    void nextTick(() => {
      measure()
      selected()?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
    }),
)
onMounted(() => {
  measure()
  requestAnimationFrame(() => (animate.value = true))
  if (root.value) {
    observer = new ResizeObserver(measure)
    observer.observe(root.value)
  }
})
onBeforeUnmount(() => observer?.disconnect())

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  e.preventDefault()
  const i = props.options.findIndex((o) => o.value === props.modelValue)
  const next = props.options[(i + (e.key === 'ArrowRight' ? 1 : -1) + props.options.length) % props.options.length]!
  emit('update:modelValue', next.value)
  void nextTick(() => root.value?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus())
}
</script>

<template>
  <div class="-mx-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none]">
    <div ref="root" role="tablist" :aria-label="label" class="relative inline-flex gap-0.5 rounded-full bg-surface-muted p-1" @keydown="onKeydown">
      <span
        v-if="indicator"
        class="pointer-events-none absolute top-1 bottom-1 left-0 rounded-full bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.06),0_2px_8px_-2px_rgb(0_0_0/0.08)]"
        :class="animate && 'transition-[transform,width] duration-(--qb-duration-slow) ease-spring'"
        :style="{ transform: `translateX(${indicator.x}px)`, width: `${indicator.w}px` }"
        aria-hidden="true"
      />
      <button
        v-for="o in options"
        :key="o.value"
        type="button"
        role="tab"
        :aria-selected="modelValue === o.value"
        :tabindex="modelValue === o.value ? 0 : -1"
        class="relative flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3.5 text-sm whitespace-nowrap transition-colors duration-(--qb-duration)"
        :class="modelValue === o.value ? 'font-medium text-fg' : 'text-fg-muted hover:text-fg'"
        @click="emit('update:modelValue', o.value)"
      >
        <component :is="o.icon" v-if="o.icon" class="size-4" aria-hidden="true" />
        {{ o.label }}
        <span v-if="o.badge" class="rounded-full bg-warning-bg px-1.5 text-xs text-warning tabular-nums">{{ o.badge }}</span>
      </button>
    </div>
  </div>
</template>
