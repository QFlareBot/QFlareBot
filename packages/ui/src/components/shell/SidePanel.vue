<script setup lang="ts">
/** 侧栏内容：标志、导航、底部的机器人状态与主题 / 退出；桌面侧栏和手机抽屉各放一份 */
import { LogOut, Moon, Sun } from 'lucide-vue-next'
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuth } from '../../composables/useAuth.js'
import { useStatus } from '../../composables/useStatus.js'
import { useTheme } from '../../composables/useTheme.js'
import BrandMark from '../BrandMark.vue'
import NavList from './NavList.vue'

const emit = defineEmits<{ navigate: [] }>()
const { theme, toggle } = useTheme()
const { logout } = useAuth()
const { status } = useStatus()
const router = useRouter()

const bot = computed(() =>
  !status.value
    ? { dot: 'bg-fg-subtle', label: '正在读取状态', title: undefined }
    : status.value.bot
      ? { dot: 'bg-success', label: '机器人已配置', title: `AppID ${status.value.bot.appId}` }
      : { dot: 'bg-warning', label: '尚未配置机器人', title: undefined },
)

function onLogout() {
  logout()
  emit('navigate')
  void router.replace('/login')
}

const iconButton = 'flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-fg-muted transition-[background-color,color,transform] duration-(--qb-duration) hover:bg-(--qb-nav-hover) hover:text-fg active:scale-90'
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="flex h-14 shrink-0 items-center gap-2.5 px-4">
      <BrandMark class="size-6 shrink-0" />
      <span class="text-sm font-semibold tracking-tight text-fg">QFlareBot</span>
      <span class="ml-auto font-mono text-xs text-fg-subtle">{{ status?.runtime ? `v${status.runtime}` : '' }}</span>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
      <NavList @navigate="emit('navigate')" />
    </div>
    <div class="flex shrink-0 items-center gap-1 px-2 pt-1 pb-2">
      <RouterLink to="/settings" :title="bot.title" class="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-xs text-fg-muted hover:text-fg" @click="emit('navigate')">
        <span class="size-2 shrink-0 rounded-full" :class="bot.dot" aria-hidden="true" />
        <span class="truncate">{{ bot.label }}</span>
      </RouterLink>
      <button type="button" :class="iconButton" :aria-label="theme === 'dark' ? '切换到浅色' : '切换到深色'" @click="toggle">
        <Sun v-if="theme === 'dark'" class="size-4" aria-hidden="true" />
        <Moon v-else class="size-4" aria-hidden="true" />
      </button>
      <button type="button" :class="iconButton" aria-label="退出登录" @click="onLogout">
        <LogOut class="size-4" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>
