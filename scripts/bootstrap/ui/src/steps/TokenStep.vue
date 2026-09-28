<script setup lang="ts">
/** ① 连接 Cloudflare：打开预填链接建主 token，粘贴回来自动验证；能访问多个账户时选一个 */
import QButton from '@panel/components/ui/QButton.vue'
import QCollapse from '@panel/components/ui/QCollapse.vue'
import { ArrowRight, ChevronDown, CircleCheck, KeyRound, Lock } from 'lucide-vue-next'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ApiError } from '../api.js'
import AccountPicker from '../components/base/AccountPicker.vue'
import LinkButton from '../components/base/LinkButton.vue'
import PermissionList from '../components/base/PermissionList.vue'
import StepCard from '../components/base/StepCard.vue'
import StepFooter from '../components/base/StepFooter.vue'
import StepHeader from '../components/base/StepHeader.vue'
import SubStep from '../components/base/SubStep.vue'
import TokenPaste from '../components/base/TokenPaste.vue'
import { useAutoVerify } from '../composables/useAutoVerify.js'
import type { Account } from '../types.js'
import { useWizard } from '../wizard.js'

/** 与 SETUP_TOKEN_URL 预填的权限组一一对应（key 相同），验证时按 key 标出缺了哪项 */
const PERMISSIONS = [
  { key: 'workers_scripts', name: 'Workers Scripts', level: '编辑' },
  { key: 'workers_kv_storage', name: 'Workers KV Storage', level: '编辑' },
  { key: 'd1', name: 'D1', level: '编辑' },
  { key: 'workers_r2', name: 'Workers R2 Storage', level: '编辑' },
  { key: 'account_settings', name: 'Account Settings', level: '读取' },
  { key: 'workers_ci', name: 'Workers 构建配置', level: '编辑', note: '英文界面叫 Workers Builds Configuration，也可能显示为 Workers CI' },
]

const w = useWizard()
const editing = ref(!w.account.value)
const opened = ref(false)
const accounts = ref<Account[]>([])
const accountId = ref('')
const showPermissions = ref(false)

const v = useAutoVerify((token) => w.verify(token, accountId.value || undefined))
const errorData = computed(() => (v.error.value instanceof ApiError ? v.error.value.data : {}))
const missing = computed(() => (errorData.value.missing as string[] | undefined) ?? [])
/** Token 本身没问题，只是要选账户：不报红 */
const needsAccount = computed(() => v.status.value === 'error' && Array.isArray(errorData.value.accounts))

watch(errorData, (data) => {
  if (Array.isArray(data.accounts)) accounts.value = data.accounts as Account[]
  if (missing.value.length) showPermissions.value = true
})
watch(accountId, (id) => id && void v.run())
watch(v.input, () => (accountId.value = ''))

const accountLabel = computed(() => w.account.value?.name ?? w.account.value?.id ?? '')
const pasteStatus = computed(() => (needsAccount.value ? 'ok' : v.status.value))
const okText = computed(() => (needsAccount.value ? 'Token 有效，选一个要部署到的账户' : `已连接账户 ${accountLabel.value}`))
const canNext = computed(() => !!w.account.value && v.status.value !== 'checking')

function next() {
  if (canNext.value) w.moveTo('options')
}

// 从 Cloudflare 的标签页切回来时，光标已经在输入框里，直接粘贴
function onFocus() {
  if (opened.value && editing.value && !v.input.value) document.getElementById('setup-token')?.focus()
}
onMounted(() => window.addEventListener('focus', onFocus))
onBeforeUnmount(() => window.removeEventListener('focus', onFocus))
</script>

<template>
  <div class="flex flex-col gap-4">
    <StepHeader :icon="KeyRound" :index="1" title="连接 Cloudflare" description="创建一个预填好权限的 API Token 粘贴回来，向导用它建资源、部署 Worker。" />

    <StepCard v-if="!editing">
      <div class="flex items-center gap-3.5">
        <span class="flex size-10 shrink-0 items-center justify-center rounded-full bg-success-bg text-success" aria-hidden="true">
          <CircleCheck class="size-5" />
        </span>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium text-fg">已连接 Cloudflare</p>
          <p class="truncate text-xs text-fg-muted">
            账户 {{ w.account.value?.name ?? '' }} <span class="font-mono text-fg-subtle">{{ w.account.value?.id }}</span>
          </p>
        </div>
        <QButton v-if="!w.deployLocked.value" size="sm" variant="ghost" @click="editing = true">换一个 Token</QButton>
      </div>
      <p v-if="w.deployLocked.value" class="mt-4 flex items-center gap-1.5 text-xs text-fg-muted">
        <Lock class="size-3.5" aria-hidden="true" />部署已经开始，Token 不能再换了。
      </p>
    </StepCard>

    <StepCard v-else>
      <SubStep :n="1" title="打开预填的创建页" :done="opened || v.status.value !== 'idle'">
        <p class="text-xs text-pretty text-fg-muted">名字和权限都填好了，确认后点 Create Token。需要先在这个浏览器登录 Cloudflare。</p>
        <LinkButton class="mt-3" :href="w.init.value!.setupTokenUrl" :variant="opened ? 'secondary' : 'primary'" @click="opened = true">
          {{ opened ? '再次打开创建页' : '打开创建页' }}
        </LinkButton>
      </SubStep>
      <SubStep :n="2" title="粘贴 Token" :done="!!w.account.value" last>
        <TokenPaste
          id="setup-token"
          v-model="v.input.value"
          label="API Token"
          placeholder="粘贴刚创建的 API Token"
          :status="pasteStatus"
          :ok-text="okText"
          :error-text="v.error.value?.message"
          @paste="v.onPaste"
          @enter="next"
        />
        <QCollapse :open="needsAccount || (accounts.length > 0 && !!accountId && v.status.value !== 'ok')">
          <!-- fieldset 的内边距不作用在 legend 上方，间距放在外层 -->
          <div class="pt-4"><AccountPicker v-model="accountId" :accounts="accounts" /></div>
        </QCollapse>
      </SubStep>
    </StepCard>

    <StepCard v-if="editing">
      <button type="button" class="flex w-full cursor-pointer items-center justify-between gap-3 text-left" :aria-expanded="showPermissions" @click="showPermissions = !showPermissions">
        <span class="min-w-0">
          <span class="block text-sm font-semibold text-fg">链接里预填的权限</span>
          <span class="mt-0.5 block text-xs text-fg-muted">链接失效时照这个手动勾选，账户范围选「所有账户」。</span>
        </span>
        <ChevronDown class="size-4 shrink-0 text-fg-muted transition-transform duration-(--qb-duration-slow)" :class="showPermissions && 'rotate-180'" aria-hidden="true" />
      </button>
      <QCollapse :open="showPermissions">
        <PermissionList class="pt-4" :items="PERMISSIONS" :missing="missing" />
      </QCollapse>
    </StepCard>

    <StepFooter>
      <QButton variant="primary" class="h-10! px-5!" :disabled="!canNext" @click="next">下一步<ArrowRight class="size-4" aria-hidden="true" /></QButton>
    </StepFooter>
  </div>
</template>
