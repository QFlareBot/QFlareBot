/**
 * 插件页的检查更新：可以一键查全部，勾选之后只构建一次。
 * 新版本新增了 Durable Object 类的，要先往仓库补 migrations，交给「添加插件 → 仓库链接」的预检。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, describeBuild } from '../api/client.js'
import type { PluginInfo } from '../api/types.js'
import { writeBatch } from '../lib/batchInstall.js'
import { installOrder } from '../lib/catalog.js'
import { eachLimit } from '../lib/gitSource.js'
import type { BuildState } from './useBuildState.js'
import { useStatus } from './useStatus.js'
import { useToast } from './useToast.js'

export interface AvailableUpdate {
  version: string | null
  sha: string
  source: string
  newPermissions: string[]
  /** 新增了 DO 类：要先改仓库，不能直接勾上更新，走仓库链接的预检 */
  newDurableObjects: string[]
}

export function usePluginUpdates(build: BuildState) {
  const { plugins } = useStatus()
  const { push } = useToast()
  const router = useRouter()

  const available = ref<Record<string, AvailableUpdate>>({})
  const checkedLatest = ref<Record<string, boolean>>({})
  const selected = ref(new Set<string>())
  const checking = ref('')
  const checkingAll = ref(false)
  const updating = ref('')
  const updatingBatch = ref(false)

  /** 能检查更新的：面板装的，而且线上就是 D1 里那一份——升级还没生效的先别叠加新的 */
  function canCheck(p: PluginInfo): boolean {
    if (!p.installed) return false
    const m = build.managedOf(p)
    return !m || m.state === 'deployed'
  }

  const checkable = computed(() => plugins.value.filter(canCheck))
  const selectedCount = computed(() => [...selected.value].filter((n) => available.value[n]).length)

  function updateLabel(p: PluginInfo, u: AvailableUpdate): string {
    const sha = u.sha.slice(0, 7)
    return u.version && u.version !== p.version ? `${u.version} · ${sha}` : `新提交 ${sha}（版本号未变）`
  }

  /** 查一个插件；有更新返回 true。新增了 DO 类的不默认勾上 */
  async function applyCheck(p: PluginInfo): Promise<boolean> {
    const res = await api.checkPluginUpdate(p.name)
    if (res.upToDate || !res.latestSource) {
      checkedLatest.value[p.name] = true
      delete available.value[p.name]
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
    available.value[p.name] = u
    if (u.newDurableObjects.length === 0) selected.value.add(p.name)
    return true
  }

  async function checkOne(p: PluginInfo) {
    checking.value = p.name
    try {
      const found = await applyCheck(p)
      const u = available.value[p.name]
      push(found && u ? `${p.displayName} 有更新：${updateLabel(p, u)}` : `${p.displayName} 已是最新`, 'success')
    } catch (e) {
      delete checkedLatest.value[p.name]
      push((e as Error).message, 'error')
    } finally {
      checking.value = ''
    }
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
    push(found ? `${found} 个插件有更新，勾选后点「更新选中」只构建一次` : '全部已是最新', 'success')
  }

  function toggleSelected(name: string, on: boolean) {
    if (on) selected.value.add(name)
    else selected.value.delete(name)
  }

  /**
   * 勾选的按依赖顺序逐个写进清单（build: false，不构建），全部写完只触发一次构建。
   *
   * 顺序与市场批量安装同一个 installOrder：新版本可能依赖同一批里别的插件（新）提供的服务，排在提供者前面会被拒。
   * 检查更新拿不到新版本的 depends / services，只能按线上这一份排（依赖关系一般不变）；
   * 新版本新加的依赖关系由 writeBatch 在「依赖未满足」时排到后面重试兜住。
   * 同一批的插件不算已经提供了服务，否则它们全都「就绪」、排序等于没排。
   */
  async function updateSelected() {
    const names = [...selected.value].filter((n) => available.value[n])
    if (!names.length || updatingBatch.value) return
    updatingBatch.value = true
    const batch = new Set(names)
    const live = new Map(plugins.value.map((p) => [p.name, p]))
    const provided = new Set(plugins.value.filter((p) => !batch.has(p.name)).flatMap((p) => [p.name, ...p.services]))
    const ordered = installOrder(
      names.map((name) => ({
        name,
        depends: live.get(name)?.depends ?? [],
        provides: [name, ...(live.get(name)?.services ?? [])],
        source: available.value[name]!.source,
      })),
      provided,
    )
    const { done, failed, warnings, build: triggered } = await writeBatch(ordered, api)
    for (const n of done) {
      delete available.value[n]
      selected.value.delete(n)
    }
    if (triggered?.ok) push(`已提交 ${done.length} 个插件的更新，只触发了一次构建，上线后版本号会变化`, 'success')
    else if (triggered) push(`${done.length} 个更新已写进清单，但触发构建失败：${triggered.error}——可在「未上线的改动」里重新构建`, 'warning')
    if (failed.length) push(`有 ${failed.length} 个没更新：${failed.join('；')}`, 'error')
    if (warnings.length) push(`提醒：${warnings.join('；')}`, 'warning')
    updatingBatch.value = false
    void build.refreshAll()
  }

  /** 单个更新：钉在检查时看到的那个 commit，就地构建 */
  async function updateOne(p: PluginInfo) {
    const u = available.value[p.name]
    if (!u) return
    // 新增了 DO 类：得先改仓库，交给仓库链接的预检，把要补的 migrations 摆出来
    if (u.newDurableObjects.length) {
      void router.push({ path: '/market', query: { tab: 'repo', source: u.source } })
      return
    }
    updating.value = p.name
    try {
      const res = await api.installPlugin(u.source)
      const { text, level } = describeBuild(`${p.displayName} 已更新到 ${res.plugin.version}`, res.build)
      push('buildUuid' in res.build ? `${text}，上线后版本号会变化` : text, level)
      if (res.warnings?.length) push(`提醒：${res.warnings.join('；')}`, 'warning')
      delete available.value[p.name]
      selected.value.delete(p.name)
    } catch (e) {
      push((e as Error).message, 'error')
    } finally {
      updating.value = ''
      void build.refreshAll()
    }
  }

  return {
    available,
    checkedLatest,
    selected,
    checking,
    checkingAll,
    updating,
    updatingBatch,
    canCheck,
    checkable,
    selectedCount,
    updateLabel,
    checkOne,
    checkAll,
    toggleSelected,
    updateSelected,
    updateOne,
  }
}

export type PluginUpdates = ReturnType<typeof usePluginUpdates>
