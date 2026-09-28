<script setup lang="ts">
/**
 * ② 基本设置：面板登录密码与资源名。先查这个名字部署过没有：部署过就说清这次重跑会做什么，
 * 并默认沿用原来的密码（以后出了破坏性更新要重跑，不必每次都改密码、重新登录）。
 */
import QButton from '@panel/components/ui/QButton.vue'
import { ArrowLeft, ArrowRight, Lock, RefreshCw, Rocket, SlidersHorizontal } from 'lucide-vue-next'
import { computed, ref, watch } from 'vue'
import Callout from '../components/base/Callout.vue'
import Spinner from '../components/base/Spinner.vue'
import StepCard from '../components/base/StepCard.vue'
import StepFooter from '../components/base/StepFooter.vue'
import StepHeader from '../components/base/StepHeader.vue'
import ExistingNotice from '../components/options/ExistingNotice.vue'
import PasswordCard from '../components/options/PasswordCard.vue'
import ResourceCard from '../components/options/ResourceCard.vue'
import { useExisting } from '../composables/useExisting.js'
import type { PasswordMode } from '../types.js'
import { useWizard } from '../wizard.js'

const w = useWizard()
const defaults = w.init.value!.defaults
const min = w.init.value!.adminTokenMinLength
const locked = w.deployLocked.value

const password = ref('')
const mode = ref<PasswordMode>('new')
const modeTouched = ref(false)
const worker = ref(w.workerName.value)
const r2 = ref(defaults.r2Name)
const error = ref('')
const busy = ref(false)

// 部署已经开始就不必再查（页面只读）
const checkName = computed(() => worker.value.trim() || defaults.workerName)
const existing = locked ? null : useExisting(checkName)
const found = computed(() => (existing?.info.value?.exists ? existing.info.value : null))
const allowKeep = computed(() => !!found.value?.hasAdminToken)

// 查到 Worker 上已经有密码：默认沿用；用户自己选过就不再替他改
watch(allowKeep, (v) => {
  if (!modeTouched.value) mode.value = v ? 'keep' : 'new'
})
function chooseMode(m: PasswordMode) {
  mode.value = m
  modeTouched.value = true
}

async function submit() {
  error.value = ''
  const keep = allowKeep.value && mode.value === 'keep'
  if (!keep && password.value.trim().length < min) {
    error.value = `至少 ${min} 个字符：面板在公网上，太短的密码容易被猜中`
    document.getElementById('admin-token')?.focus()
    return
  }
  busy.value = true
  try {
    const names = { workerName: worker.value.trim(), r2Name: r2.value.trim() }
    await w.provision(keep ? { ...names, keepAdminToken: true } : { ...names, adminToken: password.value.trim() }, !!found.value)
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <StepHeader
      :icon="SlidersHorizontal"
      :index="2"
      title="基本设置"
      :description="found ? '这个 Worker 已经部署过，确认一下这次重新部署的设置。' : '给管理面板设一个登录密码；资源名称用默认的就行。'"
    />

    <div class="empty:hidden">
      <Transition name="swap" type="transition" mode="out-in">
        <ExistingNotice v-if="found" :key="found.workerName" :info="found" />
        <p v-else-if="existing?.checking.value" class="flex items-center gap-2 px-1 text-xs text-fg-muted">
          <Spinner class="size-3" />正在检查 <code class="font-mono">{{ checkName }}</code> 有没有部署过…
        </p>
      </Transition>
    </div>

    <StepCard v-if="locked">
      <p class="flex items-center gap-1.5 text-sm font-medium text-fg"><Lock class="size-4 text-fg-muted" aria-hidden="true" />部署已经开始，设置不能再改了</p>
      <p class="mt-1 text-xs text-fg-muted">面板登录密码忘了的话，可以到 Cloudflare 的 Worker 设置里改 <code class="font-mono">ADMIN_TOKEN</code>。</p>
    </StepCard>
    <PasswordCard
      v-else
      v-model:password="password"
      :mode="mode"
      :min="min"
      :allow-keep="allowKeep"
      :error="error"
      @update:mode="chooseMode"
      @submit="submit"
    />

    <ResourceCard v-model:worker="worker" v-model:r2="r2" :defaults="defaults" :locked="locked" />

    <Callout v-if="!found">QQ 机器人不在这里填：部署完、绑好自定义域名后，到面板「设置」里用手机 QQ 扫码创建。</Callout>

    <StepFooter>
      <template #secondary>
        <QButton variant="ghost" @click="w.moveTo('token')"><ArrowLeft class="size-4" aria-hidden="true" />上一步</QButton>
      </template>
      <QButton v-if="locked" variant="primary" class="h-10! px-5!" @click="w.moveTo(w.reached.value)">
        回到当前步骤<ArrowRight class="size-4" aria-hidden="true" />
      </QButton>
      <QButton v-else variant="primary" class="h-10! px-5!" :loading="busy" @click="submit">
        <component :is="found ? RefreshCw : Rocket" class="size-4" aria-hidden="true" />{{ found ? '重新部署' : '开始部署' }}
      </QButton>
    </StepFooter>
  </div>
</template>
