<script setup lang="ts">
/** 换下来的机器人：换 AppID 时 Worker 把旧的存下来，这里一键切回（AppSecret 不经过面板） */
import { Trash2 } from 'lucide-vue-next'
import { onMounted, ref } from 'vue'
import { api } from '../../api/client.js'
import type { SavedBot } from '../../api/types.js'
import { useConfirm } from '../../composables/useConfirm.js'
import { useStatus } from '../../composables/useStatus.js'
import { useToast } from '../../composables/useToast.js'
import QButton from '../ui/QButton.vue'
import QCard from '../ui/QCard.vue'

const { status, refresh } = useStatus()
const { push } = useToast()
const confirm = useConfirm()
const bots = ref<SavedBot[]>([])
const switching = ref('')

async function reload() {
  try {
    bots.value = (await api.savedBots()).bots
  } catch (e) {
    push(`读取已保存的机器人失败：${(e as Error).message}`, 'error')
  }
}
onMounted(reload)
defineExpose({ reload })

const label = (b: { appId: string; name?: string }) => (b.name ? `${b.name}（${b.appId}）` : b.appId)
const fmtDate = (ts: number) => new Date(ts).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

async function switchTo(b: SavedBot) {
  switching.value = b.appId
  try {
    await api.switchBot(b.appId)
    await Promise.all([refresh(), reload()])
    push(`已切换到 ${label(b)}`, 'success')
  } catch (e) {
    push(`切换失败：${(e as Error).message}`, 'error')
  } finally {
    switching.value = ''
  }
}

async function remove(b: SavedBot) {
  const ok = await confirm({
    title: `删除已保存的机器人 ${label(b)}？`,
    message: '只删这里存的凭证，QQ 开放平台上的机器人不受影响。',
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  try {
    await api.removeSavedBot(b.appId)
    await reload()
    push('已删除', 'success')
  } catch (e) {
    push(`删除失败：${(e as Error).message}`, 'error')
  }
}
</script>

<template>
  <QCard v-if="bots.length" flush title="已保存的机器人" description="切回不用再填 AppSecret。切换前确认它的回调地址指向这里；管理员 openid 每个号都不一样，要重新添加">
    <TransitionGroup tag="ul" name="list" class="divide-y divide-border">
      <li v-for="b in bots" :key="b.appId" class="flex items-center justify-between gap-3 px-4 py-3">
        <div class="min-w-0">
          <p class="truncate text-sm text-fg">{{ b.name || '未命名机器人' }}</p>
          <p class="text-xs text-fg-muted"><span class="font-mono">{{ b.appId }}</span> · {{ fmtDate(b.savedAt) }} 换下</p>
        </div>
        <div class="flex shrink-0 items-center gap-1">
          <QButton size="sm" :loading="switching === b.appId" :disabled="status?.bot?.source === 'secret' || (!!switching && switching !== b.appId)" @click="switchTo(b)">切换</QButton>
          <QButton size="sm" variant="ghost" :aria-label="`删除 ${label(b)}`" :disabled="!!switching" @click="remove(b)"><Trash2 class="size-3.5" aria-hidden="true" /></QButton>
        </div>
      </li>
    </TransitionGroup>
  </QCard>
</template>
