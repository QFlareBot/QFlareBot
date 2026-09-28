<script setup lang="ts">
/** ⑤ 构建 Token：Worker 用它触发重建、读日志。和第 ① 步一样，打开预填链接、粘贴、自动验证 */
import QButton from '@panel/components/ui/QButton.vue'
import { useConfirm } from '@panel/composables/useConfirm.js'
import { Check, ShieldCheck } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import Callout from '../components/base/Callout.vue'
import LinkButton from '../components/base/LinkButton.vue'
import PermissionList from '../components/base/PermissionList.vue'
import StepCard from '../components/base/StepCard.vue'
import StepFooter from '../components/base/StepFooter.vue'
import StepHeader from '../components/base/StepHeader.vue'
import SubStep from '../components/base/SubStep.vue'
import TokenPaste from '../components/base/TokenPaste.vue'
import { useAutoVerify } from '../composables/useAutoVerify.js'
import { useWizard } from '../wizard.js'

/** 与 lib/links.mjs 的 buildsTokenUrl 预填的三项一致 */
const PERMISSIONS = [
  { key: 'workers_ci', name: 'Workers 构建配置', level: '编辑', note: '英文界面叫 Workers Builds Configuration，也可能显示为 Workers CI' },
  { key: 'workers_scripts', name: 'Workers Scripts', level: '读取' },
  { key: 'workers_observability', name: 'Workers Observability', level: '编辑', note: '面板概览读最近事件用，缺了不影响构建' },
]

const w = useWizard()
const confirm = useConfirm()
const result = computed(() => w.progress.value?.result)
const opened = ref(false)
const busy = ref(false)
const error = ref('')
const v = useAutoVerify((token) => w.verifyBuildsToken(token))
/** 重跑：Worker 上本来就有一个，不粘贴就沿用 */
const hasExisting = computed(() => !!result.value?.buildsTokenExisting)

async function finish(withToken: boolean) {
  if (withToken && v.status.value !== 'ok') return
  if (!withToken && !hasExisting.value) {
    const ok = await confirm({
      title: '先不配置构建 Token？',
      message: '在补配之前，面板上装插件会直接失败（提示「自部署未配置」）。补法写在 run 页的 Summary 里。',
      confirmText: '跳过并完成',
    })
    if (!ok) return
  }
  error.value = ''
  busy.value = true
  try {
    await w.complete(withToken ? v.input.value.trim() : undefined)
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <StepHeader :icon="ShieldCheck" :index="5" title="构建 Token" description="Worker 用它触发重新构建、读取运行日志。和第 1 步的不是同一个 Token。" />

    <Callout v-if="hasExisting" tone="success" title="Worker 上已经有构建 Token">
      直接沿用、完成引导就行；想换一个的话，照下面创建并粘贴新的。
    </Callout>

    <StepCard>
      <SubStep :n="1" title="打开预填的创建页" :done="opened || v.status.value !== 'idle'">
        <p class="text-xs text-fg-muted">权限已经勾好，确认后创建。</p>
        <LinkButton v-if="result" class="mt-3" :href="result.buildsTokenUrl" :variant="opened ? 'secondary' : 'primary'" @click="opened = true">
          {{ opened ? '再次打开创建页' : '打开创建页' }}
        </LinkButton>
      </SubStep>
      <SubStep :n="2" title="粘贴构建 Token" :done="v.status.value === 'ok'" last>
        <TokenPaste
          id="builds-token"
          v-model="v.input.value"
          label="构建 Token"
          placeholder="粘贴刚创建的构建 Token"
          :status="v.status.value"
          ok-text="验证通过，可以完成引导了"
          :error-text="v.error.value?.message"
          @paste="v.onPaste"
          @enter="finish(true)"
        />
      </SubStep>
    </StepCard>

    <StepCard title="需要的权限" description="链接里的权限没自动勾上的话，手动勾这三项，账户范围选本账户。">
      <PermissionList :items="PERMISSIONS" />
    </StepCard>

    <Callout v-if="error" tone="danger">{{ error }}</Callout>

    <StepFooter>
      <template v-if="!hasExisting" #secondary>
        <QButton variant="ghost" :disabled="busy" @click="finish(false)">先跳过，之后再配</QButton>
      </template>
      <QButton
        v-if="hasExisting && v.status.value !== 'ok'"
        variant="primary"
        class="h-10! px-5!"
        :disabled="v.status.value === 'checking'"
        :loading="busy"
        @click="finish(false)"
      >
        <Check class="size-4" aria-hidden="true" />沿用已有的，完成引导
      </QButton>
      <QButton v-else variant="primary" class="h-10! px-5!" :disabled="v.status.value !== 'ok'" :loading="busy" @click="finish(true)">
        <Check class="size-4" aria-hidden="true" />{{ hasExisting ? '换成新的，完成引导' : '完成引导' }}
      </QButton>
    </StepFooter>
  </div>
</template>
