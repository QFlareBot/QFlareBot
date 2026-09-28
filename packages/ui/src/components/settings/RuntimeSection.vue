<script setup lang="ts">
/** 运行：安全模式、日志里记录正文、命令前缀、公开地址 */
import { computed, onMounted, ref } from 'vue'
import { api } from '../../api/client.js'
import { useSettingsPatch } from '../../composables/useSettingsPatch.js'
import { useStatus } from '../../composables/useStatus.js'
import { normalizePublicUrl } from '../../lib/publicUrl.js'
import QButton from '../ui/QButton.vue'
import QCard from '../ui/QCard.vue'
import QInput from '../ui/QInput.vue'
import QSettingRow from '../ui/QSettingRow.vue'
import QSwitch from '../ui/QSwitch.vue'

const { status } = useStatus()
const { saving, save } = useSettingsPatch()
const prefixes = ref('')
const publicUrl = ref('')
const publicUrlTouched = ref(false)

onMounted(async () => {
  try {
    const { snapshot } = await api.snapshot()
    prefixes.value = (snapshot.commandPrefixes ?? ['/']).join(' ')
    publicUrl.value = snapshot.publicUrl ?? ''
  } catch {
    prefixes.value = '/'
  }
})

/** 空着就是清掉，回到「用请求进来的域名」 */
const normalized = computed(() => normalizePublicUrl(publicUrl.value))
const publicUrlError = computed(() => (publicUrlTouched.value && normalized.value === null ? '要 https:// 开头的域名，不带路径，如 https://bot.example.com' : ''))

async function savePublicUrl() {
  publicUrlTouched.value = true
  if (normalized.value === null) return
  if (await save({ publicUrl: normalized.value || null })) {
    publicUrl.value = normalized.value
    publicUrlTouched.value = false
  }
}
</script>

<template>
  <QCard>
    <div class="divide-y divide-border">
      <QSettingRow title="安全模式" description="跳过全部插件，只保留验签与回调确认。排查问题时用。">
        <QSwitch :model-value="status?.snapshot.safeMode ?? false" label="安全模式" :disabled="saving" @update:model-value="save({ safeMode: $event })" />
      </QSettingRow>
      <QSettingRow title="日志里记录消息正文" description="事件摘要日志带上前 200 字正文，不开实时调试也能看到。日志保留 3～7 天、删不掉，能进这个 Cloudflare 账户的人都看得到。">
        <QSwitch
          :model-value="status?.snapshot.logContent ?? false"
          label="日志里记录消息正文"
          :disabled="saving || status?.snapshot.logContent === undefined"
          @update:model-value="save({ logContent: $event })"
        />
      </QSettingRow>
      <QSettingRow title="命令前缀" for="prefixes" description="空格分隔，如「/ ! 。」；消息以任一前缀开头才会当命令解析">
        <form class="flex items-center gap-2" @submit.prevent="save({ commandPrefixes: prefixes.split(/\s+/).filter(Boolean) })">
          <QInput id="prefixes" v-model="prefixes" mono class="w-32" />
          <QButton type="submit" size="sm" :loading="saving">保存</QButton>
        </form>
      </QSettingRow>
      <QSettingRow
        title="机器人公开地址"
        for="public-url"
        description="插件让 QQ 来拉图片时用这个地址。一般不用填：不填时用 QQ 推送消息用的那个域名。想让图片走别的域名，或者定时推送里也要发图，才需要填。"
      >
        <template #extra>
          <p v-if="publicUrlError" id="public-url-error" class="mt-1 text-xs text-danger" role="alert">{{ publicUrlError }}</p>
        </template>
        <form class="flex w-full items-center gap-2 sm:w-auto" @submit.prevent="savePublicUrl">
          <QInput
            id="public-url"
            v-model="publicUrl"
            mono
            class="min-w-0 flex-1 sm:w-64 sm:flex-none"
            placeholder="https://bot.example.com"
            :invalid="!!publicUrlError"
            :described-by="publicUrlError ? 'public-url-error' : undefined"
          />
          <QButton type="submit" size="sm" :loading="saving">保存</QButton>
        </form>
      </QSettingRow>
    </div>
  </QCard>
</template>
