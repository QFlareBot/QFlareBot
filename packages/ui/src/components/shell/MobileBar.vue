<script setup lang="ts">
/** 手机顶栏：导航收进左侧抽屉，底部不放任何固定元素（浏览器底栏会挡） */
import { Menu } from 'lucide-vue-next'
import { computed } from 'vue'
import { useStatus } from '../../composables/useStatus.js'
import BrandMark from '../BrandMark.vue'

defineProps<{ open: boolean }>()
const emit = defineEmits<{ menu: [] }>()
const { status } = useStatus()
const bot = computed(() => (!status.value ? null : status.value.bot ? 'ok' : 'missing'))
</script>

<template>
  <header class="qb-glass sticky top-0 z-30 border-x-0 border-t-0 pt-[env(safe-area-inset-top)]">
    <div class="flex h-13 items-center gap-1.5 pr-4 pl-[max(0.25rem,env(safe-area-inset-left))]">
      <button
        type="button"
        class="flex size-11 cursor-pointer items-center justify-center rounded-md text-fg transition-transform duration-(--qb-duration) active:scale-90"
        aria-label="打开导航"
        :aria-expanded="open"
        @click="emit('menu')"
      >
        <Menu class="size-5" aria-hidden="true" />
      </button>
      <BrandMark class="size-5 shrink-0" />
      <span class="text-sm font-semibold tracking-tight text-fg">QFlareBot</span>
      <span class="flex-1" />
      <span v-if="bot" class="flex items-center gap-1.5 text-xs text-fg-muted">
        <span class="size-2 rounded-full" :class="bot === 'ok' ? 'bg-success' : 'bg-warning'" aria-hidden="true" />
        {{ bot === 'ok' ? '已配置' : '未配置机器人' }}
      </span>
    </div>
  </header>
</template>
