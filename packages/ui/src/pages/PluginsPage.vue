<script setup lang="ts">
import { ChevronRight } from 'lucide-vue-next'
import { onMounted, ref } from 'vue'
import { api } from '../api/client.js'
import type { InstallRecord, PluginInfo } from '../api/types.js'
import PageHeader from '../components/PageHeader.vue'
import QBadge from '../components/ui/QBadge.vue'
import QButton from '../components/ui/QButton.vue'
import QCard from '../components/ui/QCard.vue'
import QEmpty from '../components/ui/QEmpty.vue'
import QField from '../components/ui/QField.vue'
import QInput from '../components/ui/QInput.vue'
import QSwitch from '../components/ui/QSwitch.vue'
import { useStatus } from '../composables/useStatus.js'
import { useToast } from '../composables/useToast.js'

const { plugins, patchLocal, refresh } = useStatus()
const { push } = useToast()

async function toggle(p: PluginInfo, enabled: boolean) {
  patchLocal(p.name, { enabled })
  try {
    await api.patchPlugin(p.name, { enabled })
    push(`${p.displayName} 已${enabled ? '启用' : '禁用'}`, 'success')
  } catch (e) {
    patchLocal(p.name, { enabled: !enabled })
    push(`操作失败：${(e as Error).message}`, 'error')
  } finally {
    void refresh()
  }
}

function summary(p: PluginInfo): string[] {
  const parts: string[] = []
  if (p.commands.length) parts.push(`${p.commands.length} 个命令`)
  if (p.events.length) parts.push(`${p.events.length} 个事件`)
  if (p.buttons.length) parts.push(`${p.buttons.length} 个按键`)
  if (p.cron.length) parts.push(`${p.cron.length} 个定时`)
  if (p.routes.length) parts.push(`${p.routes.length} 个路由`)
  return parts
}

// —— 安装插件（源码构建） ——

const sourceInput = ref('')
const installing = ref(false)

/** GitHub 链接 / owner/repo → 解析 ref 的最新 commit；git: 原样交给后端校验 */
async function resolveSource(raw: string): Promise<string> {
  const s = raw.trim().replace(/\.git$/, '').replace(/\/+$/, '')
  if (s.startsWith('git:')) return s
  let m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)(?:\/tree\/([^/\s]+)?([^#\s]*))?(?:[?#].*)?$/i.exec(s)
  if (!m) m = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(s)
  if (!m) throw new Error('无法识别的来源。支持 GitHub 链接、owner/repo 或 git:owner/repo@commit[#子目录]')
  const [, owner, repo, ref = 'main', sub = ''] = m
  if (!owner || !repo) throw new Error('无法识别的来源。支持 GitHub 链接、owner/repo 或 git:owner/repo@commit[#子目录]')
  const sha = /^[0-9a-f]{7,40}$/i.test(ref) ? ref : await resolveSha(owner, repo, ref)
  return `git:${owner}/${repo}@${sha}${sub ? `#${sub.replace(/^\//, '')}` : ''}`
}

async function resolveSha(owner: string, repo: string, ref: string): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`, {
    headers: { accept: 'application/vnd.github+json' },
  })
  if (!res.ok) throw new Error(`解析 ${ref} 的最新 commit 失败（HTTP ${res.status}）。私有仓库请直接粘贴 git:owner/repo@commit`)
  const data = (await res.json()) as { sha?: string }
  if (!data.sha) throw new Error('GitHub 响应缺少 sha')
  return data.sha
}

async function install() {
  const raw = sourceInput.value.trim()
  if (!raw || installing.value) return
  installing.value = true
  try {
    const source = await resolveSource(raw)
    const result = await api.installPlugin(source)
    void refresh()
    try {
      await api.triggerBuild()
      push(`已安装 ${result.plugin.name}@${result.plugin.version} 并触发构建，上线后出现在列表里`, 'success')
      sourceInput.value = ''
    } catch (e) {
      push(`已安装 ${result.plugin.name}@${result.plugin.version}，但触发构建失败：${(e as Error).message}`, 'warning')
    }
  } catch (e) {
    push((e as Error).message, 'error')
  } finally {
    installing.value = false
  }
  void refreshBuilds()
}

// —— 构建记录 ——

const builds = ref<InstallRecord[]>([])
const buildsLoading = ref(false)

async function refreshBuilds() {
  buildsLoading.value = true
  try {
    builds.value = (await api.builds()).builds
  } catch {
    builds.value = []
  } finally {
    buildsLoading.value = false
  }
}
onMounted(() => void refreshBuilds())

const STATUS_META: Record<InstallRecord['status'], { tone: 'neutral' | 'success' | 'warning' | 'danger'; label: string }> = {
  pending: { tone: 'neutral', label: '待构建' },
  building: { tone: 'warning', label: '构建中' },
  ok: { tone: 'success', label: '完成' },
  failed: { tone: 'danger', label: '失败' },
}

const ACTION_LABELS: Record<InstallRecord['action'], string> = {
  install: '安装',
  upgrade: '升级',
  uninstall: '卸载',
  build: '构建',
}

function formatTs(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}
</script>

<template>
  <div>
    <PageHeader title="插件" description="启用 / 禁用即时生效。安装新插件粘贴源码仓库链接，构建机编译后自动上线。" />

    <QCard title="安装插件" description="输入 GitHub 链接或 git:owner/repo@commit，源码在构建机编译，声明清单与源码不一致会构建失败">
      <template #actions>
        <QButton variant="primary" :loading="installing" :disabled="!sourceInput.trim()" @click="install">安装并构建</QButton>
      </template>
      <QField id="install-source" label="插件源码" hint="支持 GitHub 链接（自动解析最新 commit）、owner/repo 或 git:owner/repo@commit[#子目录]；monorepo 用 /tree/<ref>/<子目录>">
        <template #default="{ describedBy, invalid }">
          <QInput
            id="install-source"
            v-model="sourceInput"
            mono
            placeholder="https://github.com/owner/qqbot-plugin-foo"
            :invalid="invalid"
            :described-by="describedBy"
            @keydown.enter="install"
          />
        </template>
      </QField>
    </QCard>

    <QCard class="mt-4" title="构建记录" description="安装 / 升级 / 卸载 / 构建都会记录在这里">
      <template #actions>
        <QButton size="sm" variant="ghost" :loading="buildsLoading" @click="refreshBuilds">刷新</QButton>
      </template>
      <QEmpty v-if="!builds.length" title="还没有记录" description="安装一个插件，或点刷新同步构建状态。" />
      <ul v-else class="divide-y divide-border">
        <li v-for="b in builds" :key="b.id" class="flex items-center gap-2 px-4 py-2">
          <QBadge :tone="STATUS_META[b.status].tone">{{ STATUS_META[b.status].label }}</QBadge>
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2 text-sm">
              <span class="font-medium text-fg">{{ ACTION_LABELS[b.action] }}{{ b.name ? ` ${b.name}` : '' }}</span>
              <span v-if="b.commitHash" class="font-mono text-xs text-fg-subtle">{{ b.commitHash.slice(0, 7) }}</span>
            </div>
            <p class="truncate text-xs text-fg-muted">{{ b.error ?? b.source ?? '' }}</p>
          </div>
          <span class="shrink-0 text-xs text-fg-subtle">{{ formatTs(b.ts) }}</span>
        </li>
      </ul>
    </QCard>

    <QCard class="mt-4" flush title="已装插件" description="构建上线后出现在这里；来自仓库内置清单的插件需改仓库后重建">
      <QEmpty v-if="!plugins.length" title="没有已安装的插件" description="在上方粘贴插件仓库链接安装，或在 apps/seed 的清单里加入内置插件。" />
      <ul v-else class="divide-y divide-border">
        <li v-for="p in plugins" :key="p.name" class="flex items-center gap-2 pr-2 pl-4">
          <QSwitch :model-value="p.enabled" :label="`${p.enabled ? '禁用' : '启用'} ${p.displayName}`" :disabled="!!p.error" @update:model-value="toggle(p, $event)" />
          <RouterLink :to="`/plugins/${p.name}`" class="flex min-w-0 flex-1 items-center gap-3 py-2.5 hover:text-fg">
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="text-sm font-medium text-fg">{{ p.displayName }}</span>
                <span class="font-mono text-xs text-fg-subtle">{{ p.name }}@{{ p.version }}</span>
                <QBadge v-if="p.error" tone="danger">加载失败</QBadge>
                <QBadge v-else-if="!p.enabled" tone="neutral">已禁用</QBadge>
                <QBadge v-if="p.ui" tone="accent">有页面</QBadge>
              </div>
              <p class="truncate text-xs text-fg-muted">{{ p.error ?? p.description ?? summary(p).join(' · ') }}</p>
            </div>
            <span class="hidden text-xs text-fg-subtle sm:block">{{ summary(p).join(' · ') }}</span>
            <ChevronRight class="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
          </RouterLink>
        </li>
      </ul>
    </QCard>
  </div>
</template>
