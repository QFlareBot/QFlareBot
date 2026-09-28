<script setup lang="ts">
/** 深浅色切换：默认跟随系统，点过之后记住（与面板同一个设置） */
import { useTheme } from '@panel/composables/useTheme.js'
import { Moon, Sun } from 'lucide-vue-next'

const { theme, toggle } = useTheme()
</script>

<template>
  <button
    type="button"
    class="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-fg-muted transition-[background-color,color,transform] duration-(--qb-duration) hover:bg-(--qb-nav-hover) hover:text-fg active:scale-90"
    :aria-label="theme === 'dark' ? '切换到浅色' : '切换到深色'"
    :title="theme === 'dark' ? '切换到浅色' : '切换到深色'"
    @click="toggle"
  >
    <Transition name="swap" type="transition" mode="out-in">
      <Sun v-if="theme === 'dark'" key="sun" class="size-4" aria-hidden="true" />
      <Moon v-else key="moon" class="size-4" aria-hidden="true" />
    </Transition>
  </button>
</template>
