<script setup lang="ts">
/** 导航列表：选中块跟着路由滑过去 */
import { PanelsTopLeft } from 'lucide-vue-next'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useStatus } from '../../composables/useStatus.js'
import { activeNav, NAV } from './nav.js'

const emit = defineEmits<{ navigate: [] }>()
const route = useRoute()
const { plugins } = useStatus()
const pluginPages = computed(() => plugins.value.filter((p) => p.ui && p.enabled))
const active = computed(() => activeNav(route.path))

const root = ref<HTMLElement | null>(null)
const indicator = ref<{ y: number; h: number } | null>(null)
/** 首次定位不做动画，免得一打开就从顶上滑下来 */
const animate = ref(false)
let observer: ResizeObserver | null = null

function measure() {
  const el = root.value?.querySelector<HTMLElement>('[data-active]')
  indicator.value = el ? { y: el.offsetTop, h: el.offsetHeight } : null
}

watch([active, () => pluginPages.value.length], () => void nextTick(measure))
onMounted(() => {
  measure()
  requestAnimationFrame(() => (animate.value = true))
  if (root.value) {
    observer = new ResizeObserver(measure)
    observer.observe(root.value)
  }
})
onBeforeUnmount(() => observer?.disconnect())

const itemClass = (on: boolean) => [
  'relative flex h-9 items-center gap-2.5 rounded-md px-3 text-sm transition-colors duration-(--qb-duration) ease-(--qb-ease)',
  on ? 'font-medium text-fg' : 'text-fg-muted hover:bg-(--qb-nav-hover) hover:text-fg',
]
</script>

<template>
  <nav ref="root" class="relative flex flex-col gap-0.5" aria-label="主导航">
    <span
      v-if="indicator"
      class="pointer-events-none absolute inset-x-0 top-0 rounded-md bg-(--qb-nav-active) shadow-(--qb-nav-active-shadow)"
      :class="animate && 'transition-[transform,height] duration-(--qb-duration-slow) ease-spring'"
      :style="{ transform: `translateY(${indicator.y}px)`, height: `${indicator.h}px` }"
      aria-hidden="true"
    />
    <RouterLink
      v-for="item in NAV"
      :key="item.to"
      :to="item.to"
      :class="itemClass(active === item.to)"
      :data-active="active === item.to || undefined"
      :aria-current="active === item.to ? 'page' : undefined"
      @click="emit('navigate')"
    >
      <component :is="item.icon" class="size-4" aria-hidden="true" />{{ item.label }}
    </RouterLink>
    <template v-if="pluginPages.length">
      <p class="mt-4 mb-1 px-3 text-xs font-medium text-fg-subtle">插件页面</p>
      <RouterLink
        v-for="p in pluginPages"
        :key="p.name"
        :to="`/plugin-ui/${p.name}`"
        :class="itemClass(active === `/plugin-ui/${p.name}`)"
        :data-active="active === `/plugin-ui/${p.name}` || undefined"
        :aria-current="active === `/plugin-ui/${p.name}` ? 'page' : undefined"
        @click="emit('navigate')"
      >
        <PanelsTopLeft class="size-4 shrink-0" aria-hidden="true" />
        <span class="truncate">{{ p.ui?.title ?? p.displayName }}</span>
      </RouterLink>
    </template>
  </nav>
</template>
