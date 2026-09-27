/**
 * 批量写插件清单：逐个 build: false 写进 D1，全部写完只触发一次构建。插件市场的批量安装与插件页的批量更新共用。
 * 顺序由调用方先用 installOrder 排好（提供服务的在前）；这里只管按顺序写、收集结果。
 */
import { ApiError, DEPENDENCIES_MISSING } from '../api/client.js'

export interface BatchEntry {
  name: string
  /** git:owner/repo@sha[#子目录] */
  source: string
  /** 预检时确认过已补好 DO migrations */
  acknowledgeDurableObjects?: boolean
}

/** 用到的那两个管理 API；面板里直接传 api，测试里传假的 */
export interface BatchApi {
  installPlugin(source: string, opts: { build: false; acknowledgeDurableObjects?: boolean }): Promise<{ warnings?: string[] }>
  triggerBuild(): Promise<unknown>
}

export interface BatchResult {
  /** 写进清单的插件名 */
  done: string[]
  /** 没写进去的，「名字：原因」 */
  failed: string[]
  /** 写进去了、但要让人知道的事，「名字：提醒」 */
  warnings: string[]
  /** 那一次构建：一个都没写进去就不触发（null） */
  build: { ok: true } | { ok: false; error: string } | null
}

function isDependencyMissing(err: unknown): boolean {
  return err instanceof ApiError && err.code === DEPENDENCIES_MISSING
}

/**
 * 按给定顺序逐个写，最后触发一次构建。
 *
 * 报「依赖未满足」的先放一放，这一轮别的写完再重试：installOrder 用的 depends / services 不一定是新版本的
 * （批量更新时拿不到新版本的清单，只能按线上那份排），新版本依赖同一批里别人新提供的服务时，
 * 排在提供者前面就会被拒；提供者写进 D1 之后后端就认了。一整轮一个都没写成就停，剩下的如实报错。
 * 被拒的请求什么都不写，重试是安全的。
 */
export async function writeBatch(entries: readonly BatchEntry[], api: BatchApi): Promise<BatchResult> {
  const done: string[] = []
  const failed: string[] = []
  const warnings: string[] = []
  let pending = [...entries]
  while (pending.length > 0) {
    const waiting: Array<{ entry: BatchEntry; message: string }> = []
    let progressed = false
    for (const entry of pending) {
      try {
        const res = await api.installPlugin(entry.source, {
          build: false,
          ...(entry.acknowledgeDurableObjects ? { acknowledgeDurableObjects: true } : {}),
        })
        done.push(entry.name)
        progressed = true
        for (const w of res.warnings ?? []) warnings.push(`${entry.name}：${w}`)
      } catch (e) {
        const message = (e as Error).message
        if (isDependencyMissing(e)) waiting.push({ entry, message })
        else failed.push(`${entry.name}：${message}`)
      }
    }
    if (!progressed) {
      for (const w of waiting) failed.push(`${w.entry.name}：${w.message}`)
      break
    }
    pending = waiting.map((w) => w.entry)
  }

  let build: BatchResult['build'] = null
  if (done.length > 0) {
    try {
      await api.triggerBuild()
      build = { ok: true }
    } catch (e) {
      build = { ok: false, error: (e as Error).message }
    }
  }
  return { done, failed, warnings, build }
}
