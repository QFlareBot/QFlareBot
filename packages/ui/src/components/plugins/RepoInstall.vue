<script setup lang="ts">
/**
 * 按仓库链接安装：先预检（解析最新 commit、dryRun），把权限、依赖、警告、要补的 DO migrations 摆出来，确认后再装。
 * 插件声明了 Durable Object 时要先往仓库 wrangler.jsonc 补 migrations——运行时读不到仓库里的那份配置，
 * 判断不了用户加没加，只能把原文摆出来让人确认；不拦的话装进去之后每一次构建都会失败。
 */
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, describeBuild } from '../../api/client.js'
import type { InstallPreview } from '../../api/types.js'
import { useStatus } from '../../composables/useStatus.js'
import { useToast } from '../../composables/useToast.js'
import { resolveSource } from '../../lib/gitSource.js'
import QBadge from '../ui/QBadge.vue'
import QButton from '../ui/QButton.vue'
import QCard from '../ui/QCard.vue'
import QCollapse from '../ui/QCollapse.vue'
import QField from '../ui/QField.vue'
import QInput from '../ui/QInput.vue'
import PreviewDetails from './PreviewDetails.vue'

/** 从插件页「预检升级」跳过来时带着要装的来源，打开就预检 */
const props = defineProps<{ initialSource?: string }>()
const { refresh } = useStatus()
const { push } = useToast()
const router = useRouter()

const sourceInput = ref(props.initialSource ?? '')
const previewing = ref(false)
const installing = ref(false)
const preview = ref<InstallPreview | null>(null)

async function startPreview() {
  const raw = sourceInput.value.trim()
  if (!raw || previewing.value) return
  previewing.value = true
  preview.value = null
  try {
    const { source, notice } = await resolveSource(raw)
    const result = await api.previewInstall(source)
    preview.value = notice ? { ...result, warnings: [...result.warnings, notice] } : result
  } catch (e) {
    push((e as Error).message, 'error')
  } finally {
    previewing.value = false
  }
}

async function confirmInstall() {
  const p = preview.value
  if (!p || installing.value) return
  installing.value = true
  try {
    // 构建由安装端点就地触发，这里不再补发一次——补发只能覆盖面板这一条路径，curl / 脚本装完照样什么都不会发生
    const result = await api.installPlugin(p.plugin.source, { acknowledgeDurableObjects: !!p.durableObjects })
    const label = `${result.plugin.name}@${result.plugin.version}`
    const { text, level } = describeBuild(`已${result.previous ? '升级' : '安装'} ${label}`, result.build)
    push('buildUuid' in result.build ? `${text}，上线后出现在列表里` : text, level)
    void refresh()
    await router.push('/plugins')
  } catch (e) {
    push((e as Error).message, 'error')
  } finally {
    installing.value = false
  }
}

onMounted(() => {
  if (props.initialSource) void startPreview()
})
</script>

<template>
  <QCard title="从仓库安装" description="源码在构建机上编译；声明清单与源码对不上会构建失败">
    <form class="flex flex-col gap-3" @submit.prevent="startPreview">
      <QField id="install-source" label="插件源码" hint="公开的 GitHub 仓库链接（自动取最新 commit）、owner/repo，或 git:owner/repo@commit；monorepo 用 /tree/<分支>/<子目录>">
        <template #default="{ describedBy }">
          <div class="flex flex-wrap gap-2">
            <QInput
              id="install-source"
              v-model="sourceInput"
              mono
              class="min-w-0 flex-1 basis-64"
              placeholder="https://github.com/owner/qflarebot-plugin-foo"
              :described-by="describedBy"
              @update:model-value="preview = null"
            />
            <QButton type="submit" variant="primary" :loading="previewing" :disabled="!sourceInput.trim()">预检</QButton>
          </div>
        </template>
      </QField>
    </form>

    <QCollapse :open="!!preview">
      <div v-if="preview" class="mt-4 rounded-lg border border-border p-4">
        <div class="mb-2 flex flex-wrap items-center gap-2 text-sm">
          <span class="font-medium text-fg">{{ preview.manifest.displayName ?? preview.plugin.name }}</span>
          <span class="font-mono text-xs text-fg-subtle">{{ preview.plugin.name }}@{{ preview.plugin.version }}</span>
          <QBadge v-if="preview.previous">升级自 {{ preview.previous.version }}</QBadge>
        </div>
        <PreviewDetails :preview="preview" />
        <div class="mt-4 flex flex-wrap items-center gap-2">
          <QButton variant="primary" :loading="installing" @click="confirmInstall">
            {{ preview.durableObjects ? '已加好 migrations，确认安装' : preview.previous ? '确认升级并构建' : '确认安装并构建' }}
          </QButton>
          <QButton variant="ghost" :disabled="installing" @click="preview = null">取消</QButton>
        </div>
      </div>
    </QCollapse>
  </QCard>
</template>
