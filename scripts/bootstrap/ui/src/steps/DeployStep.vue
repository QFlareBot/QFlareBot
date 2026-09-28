<script setup lang="ts">
/** ③ 部署：一步一步地亮起来；失败了能原样重试，也能回去改设置、换 Token */
import QButton from '@panel/components/ui/QButton.vue'
import { ArrowLeft, ArrowRight, CircleCheck, CircleX, RotateCcw, Rocket } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import Callout from '../components/base/Callout.vue'
import Spinner from '../components/base/Spinner.vue'
import StepCard from '../components/base/StepCard.vue'
import StepFooter from '../components/base/StepFooter.vue'
import StepHeader from '../components/base/StepHeader.vue'
import LogPanel from '../components/deploy/LogPanel.vue'
import StepTimeline from '../components/deploy/StepTimeline.vue'
import { formatDuration, serverNow } from '../lib/clock.js'
import { useWizard } from '../wizard.js'

const w = useWizard()
const p = computed(() => w.progress.value)
const phase = computed(() => (!p.value?.done ? 'running' : p.value.ok ? 'ok' : 'fail'))
const retrying = ref(false)
const retryError = ref('')

const total = computed(() => {
  const steps = p.value?.steps ?? []
  if (!steps.length) return null
  const end = phase.value === 'running' ? serverNow.value : (steps.at(-1)!.endedAt ?? serverNow.value)
  return formatDuration(end - steps[0]!.startedAt)
})

const redeploy = computed(() => w.redeploy.value || !!p.value?.result?.redeployed)
const description = computed(() =>
  redeploy.value
    ? {
        running: '正在重新部署：新版本先在预览地址做健康检查，通过了才切流量，一般三五分钟。',
        ok: '重新部署完成，资源、数据和插件都还在。下一步确认一下仓库连接。',
        fail: '重新部署没有成功。健康检查没过的话线上还是原来的版本；看一眼报错，改好之后重试就行。',
      }[phase.value]
    : {
        running: '正在 Cloudflare 上建资源、构建并部署 Worker，一般三五分钟。可以先把这一页放着。',
        ok: 'Worker 已经上线了。下一步把仓库连上，以后装插件就会自动重建。',
        fail: '部署没有成功。看一眼报错，改好之后重试就行，已经建好的资源会直接复用。',
      }[phase.value],
)

async function retry() {
  retryError.value = ''
  retrying.value = true
  try {
    await w.retry()
  } catch (err) {
    retryError.value = (err as Error).message
  } finally {
    retrying.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <StepHeader :icon="Rocket" :index="3" title="部署" :description="description" />

    <StepCard>
      <span v-if="phase === 'running'" class="qb-progress top-0 bottom-auto! text-accent" aria-hidden="true" />
      <div class="mb-4 flex items-center gap-2.5" aria-live="polite">
        <Transition name="swap" type="transition" mode="out-in">
          <Spinner v-if="phase === 'running'" key="run" class="size-4 text-accent" />
          <CircleCheck v-else-if="phase === 'ok'" key="ok" class="size-5 text-success" aria-hidden="true" />
          <CircleX v-else key="fail" class="size-5 text-danger" aria-hidden="true" />
        </Transition>
        <p class="text-sm font-medium text-fg">{{ (redeploy ? '重新' : '') + { running: '部署中', ok: '部署完成', fail: '部署失败' }[phase] }}</p>
        <span v-if="total" class="ml-auto font-mono text-xs text-fg-subtle tabular-nums">{{ phase === 'running' ? '已用' : '用时' }} {{ total }}</span>
      </div>
      <StepTimeline :steps="p?.steps ?? []" />
    </StepCard>

    <Callout v-if="phase === 'fail'" tone="danger" :title="p?.error ?? '部署失败'">
      <p v-if="p?.hint">{{ p.hint }}</p>
      <p v-if="retryError" class="mt-1 text-danger">{{ retryError }}</p>
      <p v-if="!w.canRetry()" class="mt-1">页面刷新过，管理密码没有留在浏览器里：回到第 2 步重新填一次再部署。</p>
    </Callout>
    <Callout v-for="(warning, i) in p?.result?.warnings ?? []" :key="i" tone="warning">{{ warning }}</Callout>

    <LogPanel :lines="p?.log ?? []" :default-open="phase === 'fail'" />

    <StepFooter>
      <template v-if="phase === 'fail'" #secondary>
        <QButton variant="ghost" @click="w.moveTo('options')"><ArrowLeft class="size-4" aria-hidden="true" />返回修改</QButton>
      </template>
      <QButton v-if="phase === 'running'" variant="primary" class="h-10! px-5!" disabled><Spinner class="size-3.5" />部署中…</QButton>
      <QButton v-else-if="phase === 'ok'" variant="primary" class="qb-pop h-10! px-5!" data-autofocus @click="w.moveTo('connect')">
        下一步：连接仓库<ArrowRight class="size-4" aria-hidden="true" />
      </QButton>
      <QButton v-else-if="w.canRetry()" variant="primary" class="h-10! px-5!" :loading="retrying" @click="retry">
        <RotateCcw class="size-4" aria-hidden="true" />重试
      </QButton>
      <QButton v-else variant="primary" class="h-10! px-5!" @click="w.moveTo('options')">重新填写<ArrowRight class="size-4" aria-hidden="true" /></QButton>
    </StepFooter>
  </div>
</template>
