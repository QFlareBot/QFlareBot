<script setup lang="ts">
import { ref, watch } from 'vue'
import { api } from '../api/client.js'
import PageHeader from '../components/PageHeader.vue'
import QButton from '../components/ui/QButton.vue'
import QCard from '../components/ui/QCard.vue'
import QField from '../components/ui/QField.vue'
import QInput from '../components/ui/QInput.vue'
import QSwitch from '../components/ui/QSwitch.vue'
import { useStatus } from '../composables/useStatus.js'
import { useToast } from '../composables/useToast.js'

const { status, refresh } = useStatus()
const { push } = useToast()

const appId = ref('')
const secret = ref('')
const botError = ref('')
const savingBot = ref(false)
watch(status, (s) => s?.bot && !appId.value && (appId.value = s.bot.appId), { immediate: true })

async function saveBot() {
  botError.value = ''
  if (!appId.value.trim() || !secret.value.trim()) {
    botError.value = 'AppID 与 AppSecret 都需要填写'
    return
  }
  savingBot.value = true
  try {
    await api.saveBot(appId.value.trim(), secret.value.trim())
    secret.value = ''
    await refresh()
    push('凭证已保存，并已向 QQ 开放平台验证通过', 'success')
  } catch (e) {
    botError.value = (e as Error).message
  } finally {
    savingBot.value = false
  }
}

const prefixes = ref('')
const savingSnap = ref(false)
watch(
  status,
  async (s) => {
    if (!s || prefixes.value) return
    const { snapshot } = await api.snapshot()
    prefixes.value = (snapshot.commandPrefixes ?? ['/']).join(' ')
  },
  { immediate: true },
)

async function saveSnapshot(patch: { safeMode?: boolean; commandPrefixes?: string[] }) {
  savingSnap.value = true
  try {
    const { snapshot } = await api.snapshot()
    await api.putSnapshot({ ...snapshot, ...patch })
    await refresh()
    push('已保存', 'success')
  } catch (e) {
    push(`保存失败：${(e as Error).message}`, 'error')
  } finally {
    savingSnap.value = false
  }
}
</script>

<template>
  <div>
    <PageHeader title="设置" />
    <div class="grid gap-4 lg:grid-cols-2">
      <QCard title="机器人凭证" :description="status?.bot?.source === 'secret' ? '当前由 Worker Secret 提供，这里保存的值不会覆盖它' : '保存前会先向 QQ 开放平台换取 AccessToken 验证'">
        <form class="flex flex-col gap-4" @submit.prevent="saveBot">
          <QField id="appid" label="AppID" required>
            <template #default="{ describedBy }"><QInput id="appid" v-model="appId" mono autocomplete="off" :described-by="describedBy" /></template>
          </QField>
          <QField id="secret" label="AppSecret" required :error="botError" hint="只在保存时发送一次，面板不会回显">
            <template #default="{ describedBy, invalid }"><QInput id="secret" v-model="secret" type="password" mono autocomplete="off" :described-by="describedBy" :invalid="invalid" /></template>
          </QField>
          <div><QButton type="submit" variant="primary" :loading="savingBot" :disabled="status?.bot?.source === 'secret'">保存并验证</QButton></div>
        </form>
      </QCard>

      <div class="flex flex-col gap-4">
        <QCard title="运行时">
          <div class="flex items-center justify-between gap-3">
            <div>
              <p class="text-sm font-medium text-fg">安全模式</p>
              <p class="text-xs text-fg-muted">开启后跳过全部插件，只保留验签与回调确认。排查问题时用。</p>
            </div>
            <QSwitch :model-value="status?.snapshot.safeMode ?? false" label="安全模式" :disabled="savingSnap" @update:model-value="saveSnapshot({ safeMode: $event })" />
          </div>
          <form class="mt-4 flex flex-col gap-3" @submit.prevent="saveSnapshot({ commandPrefixes: prefixes.split(/\s+/).filter(Boolean) })">
            <QField id="prefixes" label="命令前缀" hint="空格分隔，如「/ ! 。」；消息以任一前缀开头才会解析为命令">
              <template #default="{ describedBy }"><QInput id="prefixes" v-model="prefixes" mono :described-by="describedBy" /></template>
            </QField>
            <div><QButton type="submit" :loading="savingSnap">保存前缀</QButton></div>
          </form>
        </QCard>
        <QCard title="安全建议">
          <ul class="list-disc space-y-1 pl-4 text-sm text-fg-muted">
            <li>把面板域名放到 Cloudflare Access 后面（50 用户内免费），管理密钥就成了第二道锁。</li>
            <li>轮换 <code class="font-mono text-xs">ADMIN_TOKEN</code> 会让所有会话与插件页面令牌立即失效。</li>
            <li>回调地址与面板同域，QQ 只会请求 <code class="font-mono text-xs">{{ status?.webhookPath ?? '/webhook' }}</code>，其余路径不必对外。</li>
          </ul>
        </QCard>
      </div>
    </div>
  </div>
</template>
