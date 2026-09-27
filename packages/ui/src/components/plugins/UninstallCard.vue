<script setup lang="ts">
/**
 * 插件详情页底部的危险操作：卸载 = 从 D1 清单移除并就地触发重建（重建完成前插件仍在运行）。
 * 仓库内置插件不能在这里卸，只提示去改 qqbot.manifest.json。
 */
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, describeBuild } from '../../api/client.js'
import type { PluginInfo } from '../../api/types.js'
import { useConfirm } from '../../composables/useConfirm.js'
import { useToast } from '../../composables/useToast.js'
import QButton from '../ui/QButton.vue'

const props = defineProps<{ plugin: PluginInfo }>()
const { push } = useToast()
const confirm = useConfirm()
const router = useRouter()
const removing = ref(false)

async function uninstall() {
  const p = props.plugin
  // 依赖它提供的服务的插件：卸载后它们调用 ctx.service 会报错
  const dependents = p.dependents ?? []
  const answer = await confirm({
    title: `卸载 ${p.displayName}？`,
    message: `${p.name} 会从插件清单移除并触发一次重建，重建完成前它仍在运行。`,
    warning: dependents.length ? `${dependents.join('、')} 依赖它提供的服务，卸载后这些插件调用会报错。` : undefined,
    // 默认保留：误删不可逆
    checkbox: { label: '同时清空它的数据', hint: 'KV / D1 / R2 与面板里的配置一并删除，不可恢复；不勾选则数据保留，之后可在「存储」页清掉' },
    confirmText: '卸载并重建',
    danger: true,
  })
  if (!answer) return
  removing.value = true
  try {
    const res = await api.uninstallPlugin(p.name, answer.checked)
    if (res.data.hook === 'failed') push(`已卸载，但插件的 onUninstall 报错：${res.data.hookError ?? '未知原因'}`, 'warning')
    const { text, level } = describeBuild(`${p.name} 已卸载`, res.build)
    push('buildUuid' in res.build ? `${text}，完成后从列表消失` : text, level)
    if (res.warnings?.length) push(`提醒：${res.warnings.join('；')}`, 'warning')
    await router.push('/plugins')
  } catch (e) {
    push(`卸载失败：${(e as Error).message}`, 'error')
  } finally {
    removing.value = false
  }
}
</script>

<template>
  <section class="rounded-lg border border-danger/25 bg-surface p-4 shadow-card">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="min-w-0">
        <h2 class="text-sm font-semibold text-fg">卸载插件</h2>
        <p v-if="plugin.removing" class="mt-0.5 text-xs text-fg-muted">
          已经从插件清单移除，等这次重建完成后下线。构建失败的话，可以到插件页「未上线的改动」里重新构建，或者撤销卸载。
        </p>
        <p v-else-if="!plugin.installed" class="mt-0.5 text-xs text-fg-muted">
          这是仓库内置插件，在 <code class="font-mono">qqbot.manifest.json</code> 里；从那里移除后重新构建即可下架。
        </p>
        <template v-else>
          <p class="mt-0.5 text-xs text-fg-muted">从插件清单移除并触发一次重建。数据默认保留，确认时可以选择一起清空。</p>
          <p v-if="plugin.dependents?.length" class="mt-2 rounded-md bg-warning-bg px-3 py-2 text-xs text-warning">
            {{ plugin.dependents.join('、') }} 依赖它提供的服务，卸载后这些插件调用会报错。
          </p>
        </template>
      </div>
      <QButton v-if="plugin.installed && !plugin.removing" variant="danger" class="shrink-0" :loading="removing" @click="uninstall">卸载插件</QButton>
    </div>
  </section>
</template>
