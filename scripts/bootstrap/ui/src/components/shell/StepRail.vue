<script setup lang="ts">
/** 桌面左侧的步骤栏：当前步骤上有一块跟着滑动的底，走过的连线填满，走到过的步骤可以点回去看 */
import BrandMark from '@panel/components/BrandMark.vue'
import { GitFork, Power } from 'lucide-vue-next'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useLeave } from '../../composables/useLeave.js'
import { useStepStatus } from '../../composables/useStepStatus.js'
import { useWizard } from '../../wizard.js'
import ThemeToggle from '../base/ThemeToggle.vue'
import BuildChip from './BuildChip.vue'
import StepNode from './StepNode.vue'

const w = useWizard()
const { steps } = useStepStatus()
const { leave, busy, finished } = useLeave()

const list = ref<HTMLElement | null>(null)
const indicator = ref<{ y: number; h: number } | null>(null)
/** 首次定位不做动画 */
const animate = ref(false)
let observer: ResizeObserver | null = null

function measure() {
  const el = list.value?.querySelector<HTMLElement>('[data-current]')
  const li = el?.parentElement
  if (!el || !li) return
  // 用布局位置（li 相对 ol、行相对 li），不受动画中的 transform 影响
  indicator.value = { y: li.offsetTop + el.offsetTop, h: el.offsetHeight }
}
watch(w.current, () => void nextTick(measure))
onMounted(() => {
  measure()
  requestAnimationFrame(() => (animate.value = true))
  if (list.value) {
    observer = new ResizeObserver(measure)
    observer.observe(list.value)
  }
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <nav class="flex h-full flex-col" aria-label="部署步骤">
    <div class="flex items-center gap-3 px-5 pt-5">
      <BrandMark class="size-8 shrink-0" />
      <div class="min-w-0">
        <p class="text-sm leading-tight font-semibold tracking-tight text-fg">QFlareBot</p>
        <p class="text-xs text-fg-muted">部署向导</p>
      </div>
    </div>
    <p
      v-if="w.init.value?.repo"
      class="mx-4 mt-4 flex items-center gap-1.5 truncate rounded-md bg-(--qb-nav-hover) px-2.5 py-1.5 font-mono text-xs text-fg-muted"
      :title="w.init.value.repo"
    >
      <GitFork class="size-3.5 shrink-0" aria-hidden="true" /><span class="truncate">{{ w.init.value.repo }}</span>
    </p>

    <ol ref="list" class="relative mt-5 min-h-0 flex-1 overflow-y-auto px-3">
      <span
        v-if="indicator"
        class="pointer-events-none absolute inset-x-3 top-0 rounded-md bg-(--qb-nav-active) shadow-(--qb-nav-active-shadow)"
        :class="animate && 'transition-[transform,height] duration-(--qb-duration-slow) ease-spring'"
        :style="{ transform: `translateY(${indicator.y}px)`, height: `${indicator.h}px` }"
        aria-hidden="true"
      />
      <li v-for="(s, i) in steps" :key="s.id" class="relative">
        <!-- 连线：从这一步的圆点下方连到下一步；这一步做完了就填上强调色 -->
        <span v-if="i < steps.length - 1" class="absolute top-10 -bottom-2 left-[23px] w-0.5 overflow-hidden rounded-full bg-border" aria-hidden="true">
          <span class="qb-fill block size-full bg-accent" :style="{ transform: `scaleY(${s.state === 'done' ? 1 : 0})` }" />
        </span>
        <component
          :is="s.reachable && !s.current ? 'button' : 'div'"
          :type="s.reachable && !s.current ? 'button' : undefined"
          class="relative flex w-full items-start gap-3 rounded-md px-2.5 py-2.5 text-left"
          :class="s.reachable && !s.current && 'cursor-pointer transition-colors duration-(--qb-duration) hover:bg-(--qb-nav-hover)'"
          :data-current="s.current || undefined"
          :aria-current="s.current ? 'step' : undefined"
          @click="s.reachable && !s.current && w.goto(s.id)"
        >
          <StepNode :state="s.state" :n="i + 1" :current="s.current" />
          <span class="min-w-0 flex-1 pt-1">
            <span class="block text-sm leading-tight" :class="s.current ? 'font-medium text-fg' : s.state === 'todo' ? 'text-fg-muted' : 'text-fg'">{{ s.title }}</span>
            <span class="mt-0.5 block min-h-4 truncate text-xs text-fg-subtle">{{ s.note }}</span>
          </span>
        </component>
      </li>
    </ol>

    <div class="px-3 pb-2"><BuildChip /></div>
    <div class="flex items-center gap-1 border-t border-(--qb-glass-border) px-3 py-2.5">
      <ThemeToggle />
      <button
        type="button"
        class="ml-auto flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-[background-color,color,transform] duration-(--qb-duration) active:scale-95 disabled:opacity-50"
        :class="finished ? 'text-fg-muted hover:bg-(--qb-nav-hover) hover:text-fg' : 'text-danger hover:bg-danger-bg'"
        :disabled="busy"
        @click="leave"
      >
        <Power class="size-3.5" aria-hidden="true" />{{ finished ? '关闭向导' : '终止向导' }}
      </button>
    </div>
  </nav>
</template>
