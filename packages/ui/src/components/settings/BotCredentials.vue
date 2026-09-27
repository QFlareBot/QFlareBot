<script setup lang="ts">
/** 机器人凭证：保存前先向 QQ 开放平台换 AccessToken 验证；由 Worker Secret 提供时这里改不了 */
import { computed, ref, watch } from 'vue'
import { api } from '../../api/client.js'
import { useStatus } from '../../composables/useStatus.js'
import { useToast } from '../../composables/useToast.js'
import QButton from '../ui/QButton.vue'
import QCard from '../ui/QCard.vue'
import QField from '../ui/QField.vue'
import QInput from '../ui/QInput.vue'

const emit = defineEmits<{ saved: [] }>()
const { status, refresh } = useStatus()
const { push } = useToast()

const appId = ref('')
const secret = ref('')
const error = ref('')
const saving = ref(false)
const fromSecret = computed(() => status.value?.bot?.source === 'secret')

// 切换、扫码新建之后当前机器人变了：没在填新凭证就跟着换
watch(
  () => status.value?.bot?.appId,
  (id) => {
    if (id && !secret.value) appId.value = id
  },
  { immediate: true },
)

async function save() {
  error.value = ''
  if (!appId.value.trim() || !secret.value.trim()) {
    error.value = 'AppID 与 AppSecret 都需要填写'
    return
  }
  saving.value = true
  try {
    await api.saveBot(appId.value.trim(), secret.value.trim())
    secret.value = ''
    await refresh()
    emit('saved')
    push('凭证已保存，并已向 QQ 开放平台验证通过', 'success')
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <QCard title="机器人凭证" :description="fromSecret ? '当前由 Worker Secret 提供，这里保存的值不会覆盖它' : '保存前会先向 QQ 开放平台验证'">
    <div class="mb-4 flex items-center gap-2 rounded-md bg-surface-muted px-3 py-2 text-sm">
      <span class="size-2 shrink-0 rounded-full" :class="status?.bot ? 'bg-success' : 'bg-warning'" aria-hidden="true" />
      <span v-if="status?.bot" class="min-w-0 truncate text-fg">
        {{ status.bot.name || '当前机器人' }} <span class="font-mono text-xs text-fg-muted">{{ status.bot.appId }}</span>
      </span>
      <span v-else class="text-fg-muted">还没有配置机器人</span>
    </div>
    <form class="flex flex-col gap-4" @submit.prevent="save">
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <QField id="appid" label="AppID" required>
          <template #default="{ describedBy }"><QInput id="appid" v-model="appId" mono autocomplete="off" :described-by="describedBy" /></template>
        </QField>
        <QField id="secret" label="AppSecret" required :error="error" hint="只在保存时发送一次，面板不会回显">
          <template #default="{ describedBy, invalid }">
            <QInput id="secret" v-model="secret" type="password" mono autocomplete="off" :described-by="describedBy" :invalid="invalid" />
          </template>
        </QField>
      </div>
      <p v-if="status?.bot && !fromSecret" class="text-xs text-fg-muted">换号就填新的凭证保存；当前这个会自动存进「已保存的机器人」，之后一键切回。</p>
      <div><QButton type="submit" variant="primary" :loading="saving" :disabled="fromSecret">保存并验证</QButton></div>
    </form>
  </QCard>
</template>
