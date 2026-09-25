<script setup lang="ts">
import { ChevronRight } from 'lucide-vue-next'
import { onBeforeUnmount, ref } from 'vue'
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
    // 构建由安装端点就地触发，这里不再补发一次——补发只能覆盖面板这一条路径，
    // curl / 脚本装完照样什么都不会发生
    const result = await api.installPlugin(source)
    void refresh()
    const label = `${result.plugin.name}@${result.plugin.version}`
    if ('buildUuid' in result.build) {
      push(`已安装 ${label} 并触发构建，上线后出现在列表里`, 'success')
      sourceInput.value = ''
    } else {
      push(`已安装 ${label}，但触发构建失败：${result.build.error}`, 'warning')
    }
  } catch (e) {
    push((e as Error).message, 'error')
  } finally {
    installing.value = false
  }
  void refreshBuilds()
}

// —— 插件检查更新与一键更新 ——

const availableUpdate = ref<Record<string, string>>({})
const checkedLatest = ref<Record<string, boolean>>({})
const checking = ref('')
const updating = ref('')

async function checkUpdate(p: PluginInfo) {
  checking.value = p.name
  try {
    const res = await api.checkPluginUpdate(p.name)
    if (res.upToDate) {
      checkedLatest.value[p.name] = true
      push(`${p.displayName} 已是最新`, 'success')
    } else {
      availableUpdate.value[p.name] = res.latestVersion ?? '新版本'
      push(`${p.displayName} 有更新：${p.version} → ${res.latestVersion ?? '新版本'}`, 'success')
    }
  } catch (e) {
    delete checkedLatest.value[p.name]
    push((e as Error).message, 'error')
  } finally {
    checking.value = ''
  }
}

async function runUpdate(p: PluginInfo) {
  updating.value = p.name
  try {
    const res = await api.updatePlugin(p.name)
    if (res.upToDate) {
      push(`${p.displayName} 已是最新`, 'success')
    } else if (res.build?.buildUuid) {
      push(`${p.displayName} 已更新并触发构建，上线后版本号会变化`, 'success')
      delete availableUpdate.value[p.name]
    } else {
      push(`${p.displayName} 源码已更新，但触发构建失败：${res.build?.error ?? '未知原因'}`, 'warning')
    }
    void refresh()
  } catch (e) {
    push((e as Error).message, 'error')
  } finally {
    updating.value = ''
  }
  void refreshBuilds()
}

// —— 构建记录：默认折叠，展开即拉取；有构建在跑就轮询到结束 ——

const buildsOpen = ref(false)
const builds = ref<InstallRecord[]>([])
const buildsLoading = ref(false)
const buildsSyncError = ref('')
/** 拉取本身失败（网络/服务端），与 buildsSyncError（服务端说同步不了）分开提示，免得套错排查建议 */
const buildsFetchError = ref('')

/** 构建是分钟级的，5 秒一次足够，也不至于把面板变成压测工具 */
const BUILD_POLL_MS = 5000
let pollTimer: ReturnType<typeof setInterval> | null = null

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}

/**
 * 有构建在跑就轮询，跑完自动停。
 * 以前只在首次展开拉一次（buildsLoaded 守卫），于是「构建中」永远不变，看起来像卡死了。
 */
function syncPolling() {
  const inFlight = builds.value.some((b) => b.status === 'building' || b.status === 'pending')
  if (buildsOpen.value && inFlight) {
    pollTimer ??= setInterval(() => void refreshBuilds(true), BUILD_POLL_MS)
  } else {
    stopPolling()
  }
}

function toggleBuilds() {
  buildsOpen.value = !buildsOpen.value
  if (buildsOpen.value) void refreshBuilds()
  else stopPolling()
}

/** silent=true 用于轮询：不点亮按钮上的 loading，否则每 5 秒闪一次 */
async function refreshBuilds(silent = false) {
  if (!silent) buildsLoading.value = true
  try {
    const res = await api.builds()
    builds.value = res.builds
    buildsSyncError.value = res.syncError ?? ''
    buildsFetchError.value = ''
    // 只有拿到结果才决定要不要继续轮询；拉取失败就保持现状，下一轮再试
    syncPolling()
  } catch {
    if (!silent) buildsFetchError.value = '拉取构建记录失败（网络或服务端错误）'
  } finally {
    if (!silent) buildsLoading.value = false
  }
}

onBeforeUnmount(stopPolling)

// —— 重新构建：重试失败的构建、或让插件吃上机器人仓库的新依赖 ——

const rebuilding = ref(false)

async function rebuild() {
  rebuilding.value = true
  try {
    await api.triggerBuild()
    push('已触发重新构建，完成后插件自动上线', 'success')
  } catch (e) {
    push(`触发构建失败：${(e as Error).message}`, 'error')
  } finally {
    rebuilding.value = false
  }
  void refreshBuilds()
}

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

    <QCard
      class="mt-4"
      title="构建记录"
      description="默认折叠，点右上角展开；安装 / 升级 / 卸载 / 构建都会记录，只保留最近 100 条"
    >
      <template #actions>
        <QButton size="sm" variant="ghost" :loading="rebuilding" @click="rebuild">重新构建</QButton>
        <QButton size="sm" variant="ghost" :loading="buildsLoading && buildsOpen" @click="toggleBuilds">
          {{ buildsOpen ? '收起' : '展开' }}
        </QButton>
      </template>
      <template v-if="buildsOpen">
        <p v-if="buildsFetchError" class="border-b border-danger/30 bg-danger/10 px-4 py-2 text-xs text-danger">
          {{ buildsFetchError }}
        </p>
        <p v-if="buildsSyncError" class="border-b border-warning/30 bg-warning/10 px-4 py-2 text-xs text-warning">
          构建状态同步失败：{{ buildsSyncError }}（请检查 CF_ACCOUNT_ID / CF_BUILDS_TOKEN / CF_WORKER_TAG，其中 WORKER_TAG 是 scripts 列表返回的 tag 而不是名字）
        </p>
        <QEmpty v-if="!builds.length" title="还没有记录" description="安装一个插件，或点「重新构建」触发一次。" />
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
      </template>
      <p v-else class="text-xs text-fg-muted">已折叠——展开后查看记录并同步构建状态。</p>
    </QCard>

    <QCard class="mt-4" flush title="已装插件" description="构建上线后出现在这里；来自仓库内置清单的插件需改仓库后重建。点「检查更新」拉取插件源码仓库的最新提交">
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
                <QBadge v-if="availableUpdate[p.name]" tone="warning">可更新到 {{ availableUpdate[p.name] }}</QBadge>
              </div>
              <p class="truncate text-xs text-fg-muted">{{ p.error ?? p.description ?? summary(p).join(' · ') }}</p>
            </div>
            <span class="hidden text-xs text-fg-subtle sm:block">{{ summary(p).join(' · ') }}</span>
          </RouterLink>
          <QButton
            v-if="availableUpdate[p.name]"
            size="sm"
            variant="primary"
            :loading="updating === p.name"
            @click="runUpdate(p)"
          >
            更新到 {{ availableUpdate[p.name] }}
          </QButton>
          <QButton
            v-else
            size="sm"
            variant="ghost"
            :loading="checking === p.name"
            @click="checkUpdate(p)"
          >
            {{ checkedLatest[p.name] ? '已是最新' : '检查更新' }}
          </QButton>
          <ChevronRight class="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
        </li>
      </ul>
    </QCard>
  </div>
</template>
