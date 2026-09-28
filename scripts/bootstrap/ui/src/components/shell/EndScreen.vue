<script setup lang="ts">
/** 向导用不了的几种情况：已关闭、已终止、已离线、缺凭证、已被别的浏览器接管 */
import BrandMark from '@panel/components/BrandMark.vue'
import QButton from '@panel/components/ui/QButton.vue'
import { CircleCheck, CircleStop, Lock, RefreshCw, ShieldAlert, WifiOff } from 'lucide-vue-next'
import { computed } from 'vue'
import type { Ended } from '../../wizard.js'

const props = defineProps<{ kind: Ended }>()
const reload = () => location.reload()

const view = computed(
  () =>
    ({
      closed: {
        icon: CircleCheck,
        tone: 'bg-success-bg text-success',
        title: '部署向导已安全关闭',
        body: '工作流已经结束并释放了 GitHub Actions Runner，可以关掉这个标签页了。',
      },
      cancelled: {
        icon: CircleStop,
        tone: 'bg-surface-muted text-fg-muted',
        title: '向导已终止',
        body: '部署工作流已停止并释放了 runner。已经建好的资源都还在，之后重跑 Bootstrap 会直接复用。',
      },
      offline: {
        icon: WifiOff,
        tone: 'bg-warning-bg text-warning',
        title: '向导已离线',
        body: '工作流已经结束或超时（完成后保留 10 分钟，空闲 40 分钟也会自动关闭）。需要的话到 GitHub 的 Actions 页重新运行 Bootstrap。',
      },
      unclaimed: {
        icon: ShieldAlert,
        tone: 'bg-danger-bg text-danger',
        title: '访问受限',
        body: '缺少有效的向导凭证（sid）。请从 GitHub Actions 运行日志里打开完整的向导链接。',
      },
      locked: {
        icon: Lock,
        tone: 'bg-danger-bg text-danger',
        title: '向导已被接管并锁定',
        body: '这个部署向导已经在另一个浏览器里打开了。为了保护你的账户和密钥，其他访问一律屏蔽。如果那不是你：立刻在运行页点 Cancel workflow，再重新运行一次 Bootstrap。',
      },
    })[props.kind],
)
</script>

<template>
  <div class="flex min-h-dvh items-center justify-center px-4 py-10">
    <div class="w-full max-w-md rounded-xl border border-card-border bg-surface p-7 text-center shadow-card [animation:qb-rise_var(--qb-duration-slower)_var(--qb-ease-out)_backwards]">
      <BrandMark class="mx-auto size-8" />
      <span class="qb-pop mx-auto mt-6 flex size-12 items-center justify-center rounded-full" :class="view.tone" aria-hidden="true">
        <component :is="view.icon" class="size-6" />
      </span>
      <h1 class="mt-4 text-xl font-semibold tracking-tight text-balance text-fg">{{ view.title }}</h1>
      <p class="mx-auto mt-2 max-w-sm text-sm text-pretty text-fg-muted">{{ view.body }}</p>
      <QButton v-if="kind === 'offline'" class="mt-6" @click="reload"><RefreshCw class="size-3.5" aria-hidden="true" />重新连接</QButton>
    </div>
  </div>
</template>
