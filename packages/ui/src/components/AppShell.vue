<script setup lang="ts">
import { Blocks, Database, FlaskConical, LayoutDashboard, LogOut, Moon, PanelsTopLeft, Settings, Sun } from 'lucide-vue-next'
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuth } from '../composables/useAuth.js'
import { useStatus } from '../composables/useStatus.js'
import { useTheme } from '../composables/useTheme.js'

const { theme, toggle } = useTheme()
const { logout } = useAuth()
const { status, plugins } = useStatus()
const router = useRouter()

const nav = [
  { to: '/', label: '概览', icon: LayoutDashboard },
  { to: '/plugins', label: '插件', icon: Blocks },
  { to: '/storage', label: '存储', icon: Database },
  { to: '/debug', label: '调试', icon: FlaskConical },
  { to: '/settings', label: '设置', icon: Settings },
]
const pluginPages = computed(() => plugins.value.filter((p) => p.ui && p.enabled))

function onLogout() {
  logout()
  void router.replace('/login')
}
</script>

<template>
  <div class="flex h-full flex-col md:flex-row">
    <!-- 桌面侧栏 -->
    <aside class="hidden w-52 shrink-0 flex-col border-r border-border bg-surface md:flex">
      <div class="flex h-12 items-center gap-2 px-4 text-sm font-semibold text-fg">
        <span class="size-2 rounded-full" :class="status?.bot ? 'bg-success' : 'bg-warning'" aria-hidden="true" />
        QFlareBot
      </div>
      <nav class="flex flex-1 flex-col gap-0.5 px-2" aria-label="主导航">
        <RouterLink
          v-for="item in nav"
          :key="item.to"
          :to="item.to"
          class="flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm text-fg-muted transition-colors duration-(--qb-duration) hover:bg-surface-muted hover:text-fg"
          exact-active-class="bg-surface-muted text-fg font-medium"
        >
          <component :is="item.icon" class="size-4" aria-hidden="true" />{{ item.label }}
        </RouterLink>
        <template v-if="pluginPages.length">
          <p class="mt-4 mb-1 px-2.5 text-xs font-medium text-fg-subtle">插件页面</p>
          <RouterLink
            v-for="p in pluginPages"
            :key="p.name"
            :to="`/plugin-ui/${p.name}`"
            class="flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm text-fg-muted transition-colors duration-(--qb-duration) hover:bg-surface-muted hover:text-fg"
            active-class="bg-surface-muted text-fg font-medium"
          >
            <PanelsTopLeft class="size-4" aria-hidden="true" />
            <span class="truncate">{{ p.ui?.title ?? p.displayName }}</span>
          </RouterLink>
        </template>
      </nav>
      <div class="flex items-center justify-between border-t border-border px-2 py-2">
        <button type="button" class="flex size-9 cursor-pointer items-center justify-center rounded-md text-fg-muted hover:bg-surface-muted hover:text-fg" :aria-label="theme === 'dark' ? '切换到浅色' : '切换到深色'" @click="toggle">
          <Sun v-if="theme === 'dark'" class="size-4" aria-hidden="true" />
          <Moon v-else class="size-4" aria-hidden="true" />
        </button>
        <span class="font-mono text-xs text-fg-subtle">{{ status?.runtime ? `v${status.runtime}` : '' }}</span>
        <button type="button" class="flex size-9 cursor-pointer items-center justify-center rounded-md text-fg-muted hover:bg-surface-muted hover:text-fg" aria-label="退出登录" @click="onLogout">
          <LogOut class="size-4" aria-hidden="true" />
        </button>
      </div>
    </aside>

    <!-- 手机顶栏 -->
    <header class="flex h-12 shrink-0 items-center justify-between border-b border-border bg-surface px-4 md:hidden">
      <span class="flex items-center gap-2 text-sm font-semibold text-fg">
        <span class="size-2 rounded-full" :class="status?.bot ? 'bg-success' : 'bg-warning'" aria-hidden="true" />QFlareBot
      </span>
      <div class="flex items-center">
        <button type="button" class="flex size-11 cursor-pointer items-center justify-center text-fg-muted" :aria-label="theme === 'dark' ? '切换到浅色' : '切换到深色'" @click="toggle">
          <Sun v-if="theme === 'dark'" class="size-4" aria-hidden="true" /><Moon v-else class="size-4" aria-hidden="true" />
        </button>
        <button type="button" class="flex size-11 cursor-pointer items-center justify-center text-fg-muted" aria-label="退出登录" @click="onLogout">
          <LogOut class="size-4" aria-hidden="true" />
        </button>
      </div>
    </header>

    <main class="min-w-0 flex-1 overflow-y-auto">
      <div class="mx-auto max-w-6xl px-4 py-5 pb-20 md:px-6 md:py-6 md:pb-6">
        <RouterView v-slot="{ Component }">
          <Transition name="fade" mode="out-in">
            <component :is="Component" />
          </Transition>
        </RouterView>
      </div>
    </main>

    <!-- 手机底部导航（≤5 项） -->
    <nav class="fixed inset-x-0 bottom-0 flex h-14 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] md:hidden" aria-label="主导航">
      <RouterLink
        v-for="item in nav"
        :key="item.to"
        :to="item.to"
        class="flex flex-1 flex-col items-center justify-center gap-0.5 text-xs text-fg-muted"
        exact-active-class="text-fg font-medium"
      >
        <component :is="item.icon" class="size-5" aria-hidden="true" />{{ item.label }}
      </RouterLink>
    </nav>
  </div>
</template>
