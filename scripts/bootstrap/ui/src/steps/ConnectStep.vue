<script setup lang="ts">
/** ④ 连接仓库：照着三步在 Cloudflare 里点，向导自动检测；连上之后「下一步」由用户自己点 */
import QButton from '@panel/components/ui/QButton.vue'
import { useConfirm } from '@panel/composables/useConfirm.js'
import { ArrowRight, GitBranch } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import StepFooter from '../components/base/StepFooter.vue'
import StepHeader from '../components/base/StepHeader.vue'
import ConnectGuide from '../components/connect/ConnectGuide.vue'
import ConnectionStatus from '../components/connect/ConnectionStatus.vue'
import { useWizard } from '../wizard.js'

const w = useWizard()
const confirm = useConfirm()
const init = w.init.value!
const result = computed(() => w.progress.value?.result)
const connected = computed(() => !!w.connection.value?.connected)
/** 进这一步时就已经连着：只在进来那一刻判断，之后检测到连接不改布局 */
const connectedOnArrival = connected.value
const skipping = ref(false)
const skipError = ref('')
const since = Date.now()

async function skip() {
  const ok = await confirm({
    title: '先不连接仓库？',
    message: '不连接的话，在面板里装、卸插件不会自动重建。之后可以照 run 页 Summary 里的清单手动连接。',
    confirmText: '跳过并完成',
  })
  if (!ok) return
  skipError.value = ''
  skipping.value = true
  try {
    await w.complete()
  } catch (err) {
    skipError.value = (err as Error).message
  } finally {
    skipping.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <StepHeader
      :icon="GitBranch"
      :index="4"
      title="连接仓库"
      :description="
        connectedOnArrival
          ? '仓库早就连好了，向导已经确认过构建配置，直接进下一步就行。'
          : '把这个仓库连到 Worker：以后在面板里装、卸插件，Cloudflare 会自动重新构建。'
      "
    />

    <!-- 到这一步时已经连着（重跑）：结论放前面，操作说明收起来 -->
    <ConnectionStatus v-if="connectedOnArrival" :connection="w.connection.value" :since="since" />
    <ConnectGuide
      :connect-url="result?.buildsConnectUrl"
      :repo="init.repo"
      :build-command="init.buildCommand"
      :deploy-command="init.deployCommand"
      :connected="connected"
      :folded="connectedOnArrival"
    />
    <ConnectionStatus v-if="!connectedOnArrival" :connection="w.connection.value" :since="since" />

    <p v-if="skipError" class="text-xs text-danger" role="alert">{{ skipError }}</p>

    <StepFooter>
      <template v-if="!connected" #secondary>
        <QButton variant="ghost" :loading="skipping" @click="skip">先跳过，之后再连</QButton>
      </template>
      <QButton variant="primary" class="h-10! px-5!" :class="connected && 'qb-pop'" :disabled="!connected" @click="w.moveTo('builds')">
        下一步：构建 Token<ArrowRight class="size-4" aria-hidden="true" />
      </QButton>
    </StepFooter>
  </div>
</template>
