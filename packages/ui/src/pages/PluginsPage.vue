<script setup lang="ts">
import { ChevronRight } from 'lucide-vue-next'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { api, describeBuild } from '../api/client.js'
import type { InstallPreview, InstallRecord, LedgerSummary, ManagedPlugin, ManagedPluginsResult, PluginInfo } from '../api/types.js'
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

// —— D1 清单与线上的对照 ——

const managed = ref<ManagedPluginsResult | null>(null)
const managedByName = computed(() => new Map((managed.value?.plugins ?? []).map((p) => [p.name, p])))

/** 拉不到（未绑定 D1、老版本 Worker）就当没有：面板其余部分照常能用 */
async function refreshManaged(): Promise<void> {
  try {
    managed.value = await api.managedPlugins()
  } catch {
    managed.value = null
  }
}

function managedOf(p: PluginInfo): ManagedPlugin | undefined {
  return managedByName.value.get(p.name)
}

/** 一项还没在线上生效的改动（安装 / 升级 / 卸载），以及撤掉它的办法 */
interface PendingChange {
  key: string
  kind: 'install' | 'upgrade' | 'uninstall'
  name: string
  title: string
  source: string
  record: LedgerSummary | null
  error: string | null
  /** reinstall：改回线上正在跑的那一份；remove：从清单移除；null：老部署不知道线上是哪一份，撤不了 */
  undo: { type: 'reinstall'; source: string } | { type: 'remove' } | null
}

function failedError(record: LedgerSummary | null): string | null {
  return record?.status === 'failed' ? record.error : null
}

const pendingChanges = computed<PendingChange[]>(() => {
  const m = managed.value
  if (!m) return []
  const out: PendingChange[] = []
  for (const p of m.plugins) {
    const error = p.buildError ?? failedError(p.lastRecord)
    if (p.state === 'not_deployed') {
      out.push({ key: `install:${p.name}`, kind: 'install', name: p.name, title: `安装 ${p.name} ${p.version}`, source: p.source, record: p.lastRecord, error, undo: { type: 'remove' } })
    } else if (p.state === 'differs' && p.live) {
      // 线上是被它覆盖的内置插件：撤销 = 从清单移除，内置的那份留着
      const overridesBuiltin = p.live.from === 'repo'
      const undo: PendingChange['undo'] = overridesBuiltin
        ? { type: 'remove' }
        : p.live.from === 'd1' && p.live.source
          ? { type: 'reinstall', source: p.live.source }
          : null
      const title = `${overridesBuiltin ? '覆盖内置插件' : '升级'} ${p.name} ${p.live.version} → ${p.version}`
      out.push({ key: `upgrade:${p.name}`, kind: 'upgrade', name: p.name, title, source: p.source, record: p.lastRecord, error, undo })
    }
  }
  for (const r of m.removing) {
    out.push({
      key: `uninstall:${r.name}`,
      kind: 'uninstall',
      name: r.name,
      title: `卸载 ${r.name} ${r.version}`,
      source: r.source,
      record: r.lastRecord,
      error: failedError(r.lastRecord),
      undo: { type: 'reinstall', source: r.source },
    })
  }
  return out
})

const CHANGE_STATUS: Record<InstallRecord['status'], { tone: 'neutral' | 'success' | 'warning' | 'danger'; label: string }> = {
  pending: { tone: 'neutral', label: '待构建' },
  building: { tone: 'warning', label: '构建中' },
  ok: { tone: 'neutral', label: '待生效' },
  failed: { tone: 'danger', label: '构建失败' },
}

function changeStatus(c: PendingChange) {
  return c.error ? CHANGE_STATUS.failed : CHANGE_STATUS[c.record?.status ?? 'pending']
}

function undoLabel(c: PendingChange): string {
  if (c.kind === 'install') return '卸载'
  if (c.kind === 'uninstall') return '撤销卸载'
  return c.undo?.type === 'remove' ? '撤销覆盖' : '撤销升级'
}

const busyChange = ref('')

async function undoChange(c: PendingChange) {
  if (!c.undo || busyChange.value) return
  const question =
    c.undo.type === 'remove'
      ? `从插件清单里移除 ${c.name}？它没有在线上运行${c.kind === 'upgrade' ? '（线上跑的是仓库内置的那一份，会留着）' : ''}。`
      : c.kind === 'uninstall'
        ? `撤销卸载 ${c.name}？它会留在插件清单里（卸载时如果选了清数据，数据已经清掉了）。`
        : `把 ${c.name} 改回线上正在运行的版本？`
  if (!confirm(question)) return
  busyChange.value = c.key
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
    busyChange.value = ''
    void refreshAll()
  }
}

// —— 安装插件（源码构建）：先预检，确认后再装 ——

const sourceInput = ref('')
const installing = ref(false)
/**
 * 预检结果：清单摘要、权限、警告与 DO 提示摆在一起给人确认。
 * 插件声明了 Durable Object 时要先往仓库 wrangler.jsonc 补 migrations——运行时读不到仓库里的那份配置，
 * 判断不了用户加没加，只能把原文摆出来让人确认；不拦的话装进去之后每一次构建都会失败。
 */
const preview = ref<InstallPreview | null>(null)

/** GitHub 链接 / owner/repo → 解析 ref 的最新 commit；git: 原样交给后端校验 */
async function resolveSource(raw: string): Promise<string> {
  const s = raw.trim().replace(/\.git$/, '').replace(/\/+$/, '')
  if (s.startsWith('git:')) return s
  let m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)(?:\/tree\/([^/\s]+)?([^#\s]*))?(?:[?#].*)?$/i.exec(s)
  if (!m) m = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(s)
  if (!m) throw new Error('无法识别的来源。支持 GitHub 链接、owner/repo 或 git:owner/repo@commit[#子目录]')
  // 没写分支就跟默认分支走（GitHub API 认 HEAD），与检查更新用的 commits.atom 一致；写死 main 的话默认分支叫 master 的仓库会 422
  const [, owner, repo, ref = 'HEAD', sub = ''] = m
  if (!owner || !repo) throw new Error('无法识别的来源。支持 GitHub 链接、owner/repo 或 git:owner/repo@commit[#子目录]')
  const sha = /^[0-9a-f]{7,40}$/i.test(ref) ? ref : await resolveSha(owner, repo, ref)
  return `git:${owner}/${repo}@${sha}${sub ? `#${sub.replace(/^\//, '')}` : ''}`
}

async function resolveSha(owner: string, repo: string, ref: string): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`, {
    headers: { accept: 'application/vnd.github+json' },
  })
  if (!res.ok) {
    const what = ref === 'HEAD' ? '默认分支' : `分支 ${ref} `
    throw new Error(`解析${what}的最新 commit 失败（HTTP ${res.status}）：仓库或分支不存在，或是私有仓库（只支持公开的 GitHub 仓库）`)
  }
  const data = (await res.json()) as { sha?: string }
  if (!data.sha) throw new Error('GitHub 响应缺少 sha')
  return data.sha
}

async function startInstall() {
  const raw = sourceInput.value.trim()
  if (!raw || installing.value) return
  installing.value = true
  try {
    preview.value = await api.previewInstall(await resolveSource(raw))
  } catch (e) {
    push((e as Error).message, 'error')
  } finally {
    installing.value = false
  }
}

async function confirmInstall() {
  const p = preview.value
  if (!p || installing.value) return
  installing.value = true
  try {
    // 构建由安装端点就地触发，这里不再补发一次——补发只能覆盖面板这一条路径，
    // curl / 脚本装完照样什么都不会发生
    const result = await api.installPlugin(p.plugin.source, { acknowledgeDurableObjects: !!p.durableObjects })
    preview.value = null
    sourceInput.value = ''
    const label = `${result.plugin.name}@${result.plugin.version}`
    const { text, level } = describeBuild(`已${result.previous ? '升级' : '安装'} ${label}`, result.build)
    push('buildUuid' in result.build ? `${text}，上线后出现在列表里` : text, level)
  } catch (e) {
    push((e as Error).message, 'error')
  } finally {
    installing.value = false
    void refreshAll()
  }
}

// —— 检查更新：可以一键查全部，勾选之后只构建一次 ——

interface AvailableUpdate {
  version: string | null
  sha: string
  source: string
  newPermissions: string[]
  /** 新增了 DO 类：要先改仓库，不能直接勾上更新，走安装框的预检 */
  newDurableObjects: string[]
}

const availableUpdate = ref<Record<string, AvailableUpdate>>({})
const checkedLatest = ref<Record<string, boolean>>({})
const selected = ref(new Set<string>())
const checking = ref('')
const checkingAll = ref(false)
const updating = ref('')
const updatingBatch = ref(false)

/** 能检查更新的：面板装的，而且线上就是 D1 里那一份——升级还没生效的先别叠加新的 */
function canCheck(p: PluginInfo): boolean {
  if (!p.installed) return false
  const m = managedOf(p)
  return !m || m.state === 'deployed'
}

const checkable = computed(() => plugins.value.filter(canCheck))
const selectedCount = computed(() => [...selected.value].filter((n) => availableUpdate.value[n]).length)

function updateLabel(p: PluginInfo, u: AvailableUpdate): string {
  const sha = u.sha.slice(0, 7)
  return u.version && u.version !== p.version ? `${u.version} · ${sha}` : `新提交 ${sha}（版本号未变）`
}

/** 查一个插件；有更新返回 true。新增了 DO 类的不默认勾上 */
async function applyCheck(p: PluginInfo): Promise<boolean> {
  const res = await api.checkPluginUpdate(p.name)
  if (res.upToDate || !res.latestSource) {
    checkedLatest.value[p.name] = true
    delete availableUpdate.value[p.name]
    selected.value.delete(p.name)
    return false
  }
  delete checkedLatest.value[p.name]
  const u: AvailableUpdate = {
    version: res.latestVersion,
    sha: res.latestSha,
    source: res.latestSource,
    newPermissions: res.newPermissions ?? [],
    newDurableObjects: res.newDurableObjects ?? [],
  }
  availableUpdate.value[p.name] = u
  if (u.newDurableObjects.length === 0) selected.value.add(p.name)
  return true
}

async function checkUpdate(p: PluginInfo) {
  checking.value = p.name
  try {
    const found = await applyCheck(p)
    const u = availableUpdate.value[p.name]
    push(found && u ? `${p.displayName} 有更新：${updateLabel(p, u)}` : `${p.displayName} 已是最新`, 'success')
  } catch (e) {
    delete checkedLatest.value[p.name]
    push((e as Error).message, 'error')
  } finally {
    checking.value = ''
  }
}

/** 最多同时 limit 个：每个检查都要打 GitHub，一下全发出去没必要 */
async function eachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item)
    }),
  )
}

async function checkAll() {
  const targets = checkable.value
  if (!targets.length || checkingAll.value) return
  checkingAll.value = true
  let found = 0
  const errors: string[] = []
  await eachLimit(targets, 4, async (p) => {
    try {
      if (await applyCheck(p)) found += 1
    } catch (e) {
      errors.push(`${p.name}：${(e as Error).message}`)
    }
  })
  checkingAll.value = false
  if (errors.length) push(`有 ${errors.length} 个检查失败：${errors.join('；')}`, 'warning')
  push(found ? `检查完成：${found} 个插件有更新，勾选后点「更新选中」只构建一次` : '全部已是最新', 'success')
}

function toggleSelected(name: string, on: boolean) {
  if (on) selected.value.add(name)
  else selected.value.delete(name)
}

/** 勾选的逐个写进清单（build: false，不构建），全部写完只触发一次构建 */
async function updateSelected() {
  const names = [...selected.value].filter((n) => availableUpdate.value[n])
  if (!names.length || updatingBatch.value) return
  updatingBatch.value = true
  const done: string[] = []
  const failed: string[] = []
  const warnings: string[] = []
  for (const name of names) {
    const u = availableUpdate.value[name]!
    try {
      const res = await api.installPlugin(u.source, { build: false })
      done.push(name)
      for (const w of res.warnings ?? []) warnings.push(`${name}：${w}`)
    } catch (e) {
      failed.push(`${name}：${(e as Error).message}`)
    }
  }
  if (done.length) {
    for (const n of done) {
      delete availableUpdate.value[n]
      selected.value.delete(n)
    }
    try {
      await api.triggerBuild()
      push(`已提交 ${done.length} 个插件的更新，只触发了一次构建，上线后版本号会变化`, 'success')
    } catch (e) {
      push(`${done.length} 个更新已写进清单，但触发构建失败：${(e as Error).message}——可在「未上线的改动」里重新构建`, 'warning')
    }
  }
  if (failed.length) push(`有 ${failed.length} 个没更新：${failed.join('；')}`, 'error')
  if (warnings.length) push(`提醒：${warnings.join('；')}`, 'warning')
  updatingBatch.value = false
  void refreshAll()
}

/** 单个更新：钉在检查时看到的那个 commit，就地构建 */
async function runUpdate(p: PluginInfo) {
  const u = availableUpdate.value[p.name]
  if (!u) return
  // 新增了 DO 类：得先改仓库，交给安装框的预检，把要补的 migrations 摆出来
  if (u.newDurableObjects.length) {
    sourceInput.value = u.source
    await startInstall()
    window.scrollTo({ top: 0, behavior: 'smooth' })
    return
  }
  updating.value = p.name
  try {
    const res = await api.installPlugin(u.source)
    const { text, level } = describeBuild(`${p.displayName} 已更新到 ${res.plugin.version}`, res.build)
    push('buildUuid' in res.build ? `${text}，上线后版本号会变化` : text, level)
    if (res.warnings?.length) push(`提醒：${res.warnings.join('；')}`, 'warning')
    delete availableUpdate.value[p.name]
    selected.value.delete(p.name)
  } catch (e) {
    push((e as Error).message, 'error')
  } finally {
    updating.value = ''
    void refreshAll()
  }
}

// —— 构建记录：默认折叠，展开即拉取 ——

const buildsOpen = ref(false)
const builds = ref<InstallRecord[]>([])
const buildsLoading = ref(false)
const buildsSyncError = ref('')
/** 拉取本身失败（网络/服务端），与 buildsSyncError（服务端说同步不了）分开提示，免得套错排查建议 */
const buildsFetchError = ref('')

function toggleBuilds() {
  buildsOpen.value = !buildsOpen.value
  if (buildsOpen.value) void refreshBuilds()
}

/** silent=true 用于轮询：不点亮按钮上的 loading，否则每 5 秒闪一次 */
async function refreshBuilds(silent = false) {
  if (!silent) buildsLoading.value = true
  try {
    const res = await api.builds()
    builds.value = res.builds
    buildsSyncError.value = res.syncError ?? ''
    buildsFetchError.value = ''
  } catch {
    if (!silent) buildsFetchError.value = '拉取构建记录失败（网络或服务端错误）'
  } finally {
    if (!silent) buildsLoading.value = false
  }
}

async function refreshAll(): Promise<void> {
  await Promise.all([refresh(), refreshManaged(), buildsOpen.value ? refreshBuilds(true) : Promise.resolve()])
}

// —— 有构建在跑就轮询到结束，结束时刷新插件列表（线上换了版本） ——

/** 构建是分钟级的，5 秒一次足够，也不至于把面板变成压测工具 */
const BUILD_POLL_MS = 5000
let buildTimer: ReturnType<typeof setInterval> | null = null

const building = computed(() => !!managed.value?.building || builds.value.some((b) => b.status === 'building'))

/** 拉构建记录会顺带向 Cloudflare 同步状态，所以先拉它、再看对照表 */
async function pollTick() {
  await refreshBuilds(true)
  await refreshManaged()
}

watch(building, (on, was) => {
  if (on) buildTimer ??= setInterval(() => void pollTick(), BUILD_POLL_MS)
  else if (buildTimer) {
    clearInterval(buildTimer)
    buildTimer = null
  }
  if (was && !on) void refresh()
})

onMounted(() => void refreshManaged())
onBeforeUnmount(() => {
  if (buildTimer) clearInterval(buildTimer)
})

// —— 重新构建：重试失败的构建 ——

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
  await refreshBuilds(!buildsOpen.value)
  void refreshManaged()
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

    <p v-if="building" class="mb-4 rounded-md border border-warning/30 bg-warning/10 px-4 py-2 text-sm text-warning">
      有构建正在进行，完成后这里会自动刷新。
    </p>

    <QCard title="安装插件" description="输入 GitHub 链接或 git:owner/repo@commit，先预检再安装。源码在构建机编译，声明清单与源码不一致会构建失败">
      <template #actions>
        <QButton variant="primary" :loading="installing && !preview" :disabled="!sourceInput.trim() || !!preview" @click="startInstall">预检</QButton>
      </template>
      <QField id="install-source" label="插件源码" hint="只支持公开的 GitHub 仓库：GitHub 链接（自动解析最新 commit）、owner/repo 或 git:owner/repo@commit[#子目录]；monorepo 用 /tree/<ref>/<子目录>">
        <template #default="{ describedBy, invalid }">
          <QInput
            id="install-source"
            v-model="sourceInput"
            mono
            placeholder="https://github.com/owner/qqbot-plugin-foo"
            :invalid="invalid"
            :described-by="describedBy"
            @keydown.enter="startInstall"
          />
        </template>
      </QField>
      <div v-if="preview" class="mt-3 rounded-md border border-border p-3">
        <div class="flex flex-wrap items-center gap-2 text-sm">
          <span class="font-medium text-fg">{{ preview.manifest.displayName ?? preview.plugin.name }}</span>
          <span class="font-mono text-xs text-fg-subtle">{{ preview.plugin.name }}@{{ preview.plugin.version }}</span>
          <QBadge v-if="preview.previous" tone="neutral">升级自 {{ preview.previous.version }}</QBadge>
        </div>
        <p v-if="preview.manifest.description" class="mt-1 text-xs text-fg-muted">{{ preview.manifest.description }}</p>
        <dl class="mt-2 flex flex-col gap-1.5 text-xs">
          <div class="flex flex-wrap items-center gap-1">
            <dt class="mr-1 text-fg-muted">权限</dt>
            <dd class="flex flex-wrap gap-1">
              <QBadge v-for="perm in preview.manifest.permissions" :key="perm">{{ perm }}</QBadge>
              <span v-if="!preview.manifest.permissions.length" class="text-fg-subtle">无</span>
            </dd>
          </div>
          <div v-if="preview.manifest.commands.length" class="flex flex-wrap items-center gap-1">
            <dt class="mr-1 text-fg-muted">命令</dt>
            <dd class="font-mono">{{ preview.manifest.commands.map((c) => `/${c}`).join('  ') }}</dd>
          </div>
          <div v-if="preview.manifest.services.length" class="flex flex-wrap items-center gap-1">
            <dt class="mr-1 text-fg-muted">提供服务</dt>
            <dd class="font-mono">{{ preview.manifest.services.join('、') }}</dd>
          </div>
          <div class="flex flex-wrap items-center gap-1">
            <dt class="mr-1 text-fg-muted">第三方依赖</dt>
            <dd class="flex flex-wrap items-center gap-1">
              <QBadge v-for="(range, pkg) in preview.dependencies" :key="pkg">
                <span class="font-mono">{{ pkg }} {{ range }}</span>
              </QBadge>
              <span v-if="!Object.keys(preview.dependencies ?? {}).length" class="text-fg-subtle">无</span>
              <span v-else class="text-fg-subtle">构建时按插件仓库的 lockfile 安装，与插件一起打包</span>
            </dd>
          </div>
        </dl>
        <ul v-if="preview.warnings.length" class="mt-2 flex flex-col gap-1 rounded-md border border-warning/30 bg-warning/10 p-2 text-xs text-warning">
          <li v-for="w in preview.warnings" :key="w">{{ w }}</li>
        </ul>
        <pre v-if="preview.durableObjects" class="mt-2 whitespace-pre-wrap rounded-md border border-warning/30 bg-warning/10 p-2 font-mono text-xs text-warning">{{ preview.durableObjects.message }}</pre>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <QButton variant="primary" :loading="installing" @click="confirmInstall">
            {{ preview.durableObjects ? '已加好 migrations，确认安装' : preview.previous ? '确认升级并构建' : '确认安装并构建' }}
          </QButton>
          <QButton variant="ghost" :disabled="installing" @click="preview = null">取消</QButton>
        </div>
      </div>
    </QCard>

    <QCard
      v-if="pendingChanges.length"
      class="mt-4"
      flush
      title="未上线的改动"
      description="已经写进插件清单、但线上还没生效的安装 / 升级 / 卸载。构建失败时线上保持上一次成功的版本：在这里撤掉失败的那一项，再重新构建"
    >
      <template #actions>
        <QButton size="sm" variant="ghost" :loading="rebuilding" @click="rebuild">重新构建</QButton>
      </template>
      <ul class="divide-y divide-border">
        <li v-for="c in pendingChanges" :key="c.key" class="flex items-center gap-2 px-4 py-2.5">
          <QBadge :tone="changeStatus(c).tone">{{ changeStatus(c).label }}</QBadge>
          <div class="min-w-0 flex-1">
            <div class="text-sm font-medium text-fg">{{ c.title }}</div>
            <p class="truncate font-mono text-xs text-fg-subtle">{{ c.source }}</p>
            <p v-if="c.error" class="mt-0.5 whitespace-pre-wrap break-words text-xs text-danger">{{ c.error }}</p>
          </div>
          <QButton
            v-if="c.undo"
            size="sm"
            :variant="c.kind === 'install' ? 'danger' : 'ghost'"
            :loading="busyChange === c.key"
            @click="undoChange(c)"
          >
            {{ undoLabel(c) }}
          </QButton>
        </li>
      </ul>
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
              <p class="truncate text-xs" :class="b.status === 'failed' && b.error ? 'text-danger' : 'text-fg-muted'">{{ b.error ?? b.source ?? '' }}</p>
            </div>
            <span class="shrink-0 text-xs text-fg-subtle">{{ formatTs(b.ts) }}</span>
          </li>
        </ul>
      </template>
      <p v-else class="text-xs text-fg-muted">已折叠——展开后查看记录并同步构建状态。</p>
    </QCard>

    <QCard class="mt-4" flush title="已装插件" description="构建上线后出现在这里；来自仓库内置清单的插件需改仓库后重建。「检查全部更新」拉取各插件源码仓库的最新提交，勾选后一次构建">
      <template #actions>
        <QButton v-if="selectedCount" size="sm" variant="primary" :loading="updatingBatch" @click="updateSelected">更新选中（{{ selectedCount }}）</QButton>
        <QButton size="sm" variant="ghost" :loading="checkingAll" :disabled="!checkable.length || updatingBatch" @click="checkAll">检查全部更新</QButton>
      </template>
      <QEmpty v-if="!plugins.length" title="没有已安装的插件" description="在上方粘贴插件仓库链接安装，或在 apps/seed 的清单里加入内置插件。" />
      <ul v-else class="divide-y divide-border">
        <li v-for="p in plugins" :key="p.name" class="flex items-center gap-2 pr-2 pl-4">
          <input
            v-if="availableUpdate[p.name]"
            type="checkbox"
            class="size-4 shrink-0"
            :checked="selected.has(p.name)"
            :disabled="!!availableUpdate[p.name]?.newDurableObjects.length || updatingBatch"
            :aria-label="`选中 ${p.displayName} 的更新`"
            @change="toggleSelected(p.name, ($event.target as HTMLInputElement).checked)"
          />
          <QSwitch :model-value="p.enabled" :label="`${p.enabled ? '禁用' : '启用'} ${p.displayName}`" :disabled="!!p.error" @update:model-value="toggle(p, $event)" />
          <RouterLink :to="`/plugins/${p.name}`" class="flex min-w-0 flex-1 items-center gap-3 py-2.5 hover:text-fg">
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="text-sm font-medium text-fg">{{ p.displayName }}</span>
                <span class="font-mono text-xs text-fg-subtle">{{ p.name }}@{{ p.version }}</span>
                <QBadge v-if="p.error" tone="danger">加载失败</QBadge>
                <QBadge v-else-if="!p.enabled" tone="neutral">已禁用</QBadge>
                <QBadge v-if="p.ui" tone="accent">有页面</QBadge>
                <QBadge v-if="p.removing" tone="warning">卸载待生效</QBadge>
                <QBadge v-else-if="managedOf(p)?.state === 'differs'" :tone="managedOf(p)?.buildError || managedOf(p)?.lastRecord?.status === 'failed' ? 'danger' : 'warning'">
                  {{ managedOf(p)?.buildError || managedOf(p)?.lastRecord?.status === 'failed' ? '升级失败' : `待升级到 ${managedOf(p)?.version}` }}
                </QBadge>
                <QBadge v-if="availableUpdate[p.name]" tone="warning">可更新：{{ updateLabel(p, availableUpdate[p.name]!) }}</QBadge>
              </div>
              <p class="truncate text-xs text-fg-muted">{{ p.error ?? p.description ?? summary(p).join(' · ') }}</p>
              <p v-if="availableUpdate[p.name]?.newPermissions.length" class="text-xs text-warning">
                新版本新增权限：{{ availableUpdate[p.name]?.newPermissions.join('、') }}
              </p>
              <p v-if="availableUpdate[p.name]?.newDurableObjects.length" class="text-xs text-warning">
                新版本新增 Durable Object 类（{{ availableUpdate[p.name]?.newDurableObjects.join('、') }}），要先往仓库补 migrations，不能批量更新
              </p>
            </div>
            <span class="hidden text-xs text-fg-subtle sm:block">{{ summary(p).join(' · ') }}</span>
          </RouterLink>
          <QButton
            v-if="availableUpdate[p.name]"
            size="sm"
            variant="primary"
            :loading="updating === p.name"
            :disabled="updatingBatch"
            @click="runUpdate(p)"
          >
            {{ availableUpdate[p.name]?.newDurableObjects.length ? '预检升级' : '更新' }}
          </QButton>
          <QButton
            v-else-if="canCheck(p)"
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
