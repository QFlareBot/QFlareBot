<script setup lang="ts">
/** 完成后这一页保留 10 分钟：实时倒计时，也可以立即关闭、释放 runner */
import QButton from '@panel/components/ui/QButton.vue'
import { Power } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import { formatClock, serverNow } from '../../lib/clock.js'
import { useWizard } from '../../wizard.js'
import StepCard from '../base/StepCard.vue'

const WINDOW_MS = 10 * 60 * 1000
const props = defineProps<{ closesAt: number }>()
const w = useWizard()
const busy = ref(false)
const left = computed(() => Math.max(0, props.closesAt - serverNow.value))

async function close() {
  busy.value = true
  try {
    await w.exitWizard()
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <StepCard>
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium text-fg">
          这一页会在 <span class="font-mono tabular-nums">{{ formatClock(left) }}</span> 后自动关闭
        </p>
        <p class="mt-0.5 text-xs text-pretty text-fg-muted">方便你查看、复制上面的信息。用完可以立即关闭，释放 GitHub Actions Runner。</p>
      </div>
      <QButton class="self-start sm:self-auto" :loading="busy" @click="close"><Power class="size-3.5" aria-hidden="true" />立即关闭向导</QButton>
    </div>
    <span class="mt-4 block h-1 overflow-hidden rounded-full bg-surface-muted" aria-hidden="true">
      <span class="qb-meter block h-full rounded-full bg-accent/60" :style="{ transform: `scaleX(${left / WINDOW_MS})` }" />
    </span>
    <p class="mt-4 text-xs text-pretty text-fg-subtle">这一页上的地址和账户信息只在这里显示：run 页的 Summary 是公开的，那里不会写它们。</p>
  </StepCard>
</template>
