<script setup lang="ts">
/** 写进了清单、线上还没生效的安装 / 升级 / 卸载；构建失败时在这里撤掉失败的那一项 */
import { CircleAlert } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import { api, describeBuild } from '../../api/client.js'
import type { BuildState } from '../../composables/useBuildState.js'
import { useConfirm } from '../../composables/useConfirm.js'
import { useToast } from '../../composables/useToast.js'
import { changeStatus, undoLabel, type PendingChange } from '../../lib/pendingChanges.js'
import QBadge from '../ui/QBadge.vue'
import QButton from '../ui/QButton.vue'
import QCard from '../ui/QCard.vue'

const props = defineProps<{ build: BuildState }>()
const { push } = useToast()
const confirm = useConfirm()
const busy = ref('')
const failed = computed(() => props.build.changes.value.some((c) => changeStatus(c).tone === 'danger'))

function question(c: PendingChange) {
  if (c.undo?.type === 'remove')
    return {
      title: `从插件清单里移除 ${c.name}？`,
      message: `它没有在线上运行${c.kind === 'upgrade' ? '（线上跑的是仓库内置的那一份，会留着）' : ''}。`,
      confirmText: '移除',
      danger: true,
    }
  if (c.kind === 'uninstall')
    return { title: `撤销卸载 ${c.name}？`, message: '它会留在插件清单里（卸载时如果选了清数据，数据已经清掉了）。', confirmText: '撤销卸载' }
  return { title: `把 ${c.name} 改回线上正在运行的版本？`, message: '会按线上那一份的来源重新安装并触发一次构建。', confirmText: '改回去' }
}

async function undo(c: PendingChange) {
  if (!c.undo || busy.value) return
  if (!(await confirm(question(c)))) return
  busy.value = c.key
  try {
    if (c.undo.type === 'remove') {
      const res = await api.uninstallPlugin(c.name)
      const { text, level } = describeBuild(`已从清单移除 ${c.name}`, res.build)
      push(text, level)
    } else {
      const res = await api.installPlugin(c.undo.source)
      const { text, level } = describeBuild(`已撤销 ${c.name} 的${c.kind === 'uninstall' ? '卸载' : '升级'}`, res.build)
      push(text, level)
    }
  } catch (e) {
    push((e as Error).message, 'error')
  } finally {
    busy.value = ''
    void props.build.refreshAll()
  }
}
</script>

<template>
  <QCard flush title="未上线的改动" description="构建失败时线上保持上一次成功的版本：撤掉失败的那一项，再重新构建">
    <template #actions>
      <CircleAlert v-if="failed" class="size-4 text-danger" aria-label="有构建失败" />
      <QButton size="sm" :variant="failed ? 'primary' : 'ghost'" :loading="build.rebuilding.value" @click="build.rebuild">重新构建</QButton>
    </template>
    <TransitionGroup tag="ul" name="list" class="divide-y divide-border">
      <li v-for="c in build.changes.value" :key="c.key" class="flex items-center gap-3 px-4 py-3">
        <QBadge :tone="changeStatus(c).tone">{{ changeStatus(c).label }}</QBadge>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium text-fg">{{ c.title }}</p>
          <p class="truncate font-mono text-xs text-fg-subtle">{{ c.source }}</p>
          <p v-if="c.error" class="mt-1 rounded-md bg-danger-bg px-2 py-1 text-xs break-words whitespace-pre-wrap text-danger">{{ c.error }}</p>
        </div>
        <QButton v-if="c.undo" size="sm" :variant="c.kind === 'install' ? 'danger' : 'ghost'" :loading="busy === c.key" @click="undo(c)">
          {{ undoLabel(c) }}
        </QButton>
      </li>
    </TransitionGroup>
  </QCard>
</template>
