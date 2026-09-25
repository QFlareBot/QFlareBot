<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuth } from '../composables/useAuth.js'
import QButton from '../components/ui/QButton.vue'
import QField from '../components/ui/QField.vue'
import QInput from '../components/ui/QInput.vue'

const token = ref('')
const error = ref('')
const busy = ref(false)
const { login } = useAuth()
const router = useRouter()

async function submit() {
  error.value = ''
  if (!token.value.trim()) {
    error.value = '请输入管理密钥'
    return
  }
  busy.value = true
  try {
    await login(token.value.trim())
    await router.replace((router.currentRoute.value.query.redirect as string) || '/')
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="flex min-h-full items-center justify-center px-4">
    <form class="w-full max-w-sm rounded-lg border border-border bg-surface p-6 shadow-(--qb-shadow)" @submit.prevent="submit">
      <h1 class="text-lg font-semibold text-fg">FlareBot 控制台</h1>
      <p class="mt-1 mb-5 text-sm text-fg-muted">输入部署时设置的 <code class="font-mono text-xs">ADMIN_TOKEN</code>。登录后浏览器只保存 7 天有效的会话令牌。</p>
      <QField id="token" label="管理密钥" :error="error">
        <template #default="{ describedBy, invalid }">
          <QInput id="token" v-model="token" type="password" autocomplete="current-password" mono :described-by="describedBy" :invalid="invalid" />
        </template>
      </QField>
      <QButton type="submit" variant="primary" class="mt-5 w-full" :loading="busy">登录</QButton>
    </form>
  </div>
</template>
