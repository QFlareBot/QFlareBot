/**
 * 从插件目录批量安装：逐个解析最新 commit 并 dryRun 预检（什么都不写），
 * 确认后按依赖顺序写进清单（build: false），全部写完只触发一次构建。
 */
import { computed, ref, type Ref } from 'vue'
import { useRouter } from 'vue-router'
import { ApiError, DEPENDENCIES_MISSING, api } from '../api/client.js'
import type { InstallPreview } from '../api/types.js'
import { writeBatch } from '../lib/batchInstall.js'
import { batchItemOf, dependsCoveredByBatch, installOrder, installUrlOf, type CatalogPlugin } from '../lib/catalog.js'
import { eachLimit, resolveSource } from '../lib/gitSource.js'
import { useStatus } from './useStatus.js'
import { useToast } from './useToast.js'

export interface PreviewRow {
  plugin: CatalogPlugin
  source: string | null
  preview: InstallPreview | null
  /** 装不了的原因；有它就不装 */
  error: string | null
  /** 依赖由同一批里排在前面的插件提供：预检不写 D1，所以现在看不到，按顺序装就能过 */
  waitsForBatch: boolean
  notice: string | null
  /** 声明了 DO 的：确认已往仓库补好 migrations 才装 */
  ackDo: boolean
}

export function installable(r: PreviewRow): boolean {
  if (r.error || !r.source) return false
  if (r.waitsForBatch) return true
  return !!r.preview && (!r.preview.durableObjects || r.ackDo)
}

/** available：已经有人提供的服务（批量安装排顺序、判断依赖时用） */
export function useCatalogInstall(available: Ref<Set<string>>) {
  const { refresh } = useStatus()
  const { push } = useToast()
  const router = useRouter()

  const rows = ref<PreviewRow[] | null>(null)
  const previewing = ref(false)
  const installing = ref(false)
  const installableRows = computed(() => (rows.value ?? []).filter(installable))

  async function startPreview(picked: CatalogPlugin[]) {
    if (!picked.length || previewing.value || installing.value) return
    previewing.value = true
    const batch = picked.map(batchItemOf)
    const ordered = installOrder(
      picked.map((p) => ({ ...batchItemOf(p), plugin: p })),
      available.value,
    )
    const out: PreviewRow[] = ordered.map(({ plugin }) => ({ plugin, source: null, preview: null, error: null, waitsForBatch: false, notice: null, ackDo: false }))
    await eachLimit(out, 4, async (row) => {
      try {
        const { source, notice } = await resolveSource(installUrlOf(row.plugin))
        row.source = source
        row.notice = notice ?? null
        row.preview = await api.previewInstall(source)
      } catch (e) {
        const coveredByBatch =
          e instanceof ApiError && e.code === DEPENDENCIES_MISSING && dependsCoveredByBatch(batchItemOf(row.plugin), batch, available.value)
        if (coveredByBatch && !row.plugin.durableObjects?.length) row.waitsForBatch = true
        else if (coveredByBatch) row.error = `${(e as Error).message}；它还声明了 Durable Object，请单独安装`
        else row.error = (e as Error).message
      }
    })
    rows.value = out
    previewing.value = false
  }

  function cancel() {
    rows.value = null
  }

  /** 按依赖顺序（rows 预检时已按 installOrder 排好）逐个写进清单，全部写完只触发一次构建；装上了就回插件页 */
  async function confirm(): Promise<void> {
    const list = installableRows.value
    if (!list.length || installing.value) return
    installing.value = true
    const { done, failed, warnings, build } = await writeBatch(
      list.map((row) => ({ name: row.plugin.name, source: row.source!, acknowledgeDurableObjects: !!row.preview?.durableObjects && row.ackDo })),
      api,
    )
    if (build?.ok) push(`已安装 ${done.join('、')}，只触发了一次构建，上线后出现在插件列表里`, 'success')
    else if (build) push(`${done.length} 个插件已写进清单，但触发构建失败：${build.error}——可在插件页「未上线的改动」里重新构建`, 'warning')
    if (failed.length) push(`有 ${failed.length} 个没装上：${failed.join('；')}`, 'error')
    if (warnings.length) push(`提醒：${warnings.join('；')}`, 'warning')
    installing.value = false
    if (done.length) {
      rows.value = null
      void refresh()
      await router.push('/plugins')
    }
  }

  return { rows, previewing, installing, installableRows, startPreview, cancel, confirm }
}
