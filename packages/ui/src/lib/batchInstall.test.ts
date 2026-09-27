import { describe, expect, it, vi } from 'vitest'
import { ApiError, DEPENDENCIES_MISSING } from '../api/client.js'
import { writeBatch, type BatchApi } from './batchInstall.js'

/**
 * 假的管理 API：provides 是每个来源写进去之后提供的服务，needs 是写它时要求已经有人提供的服务
 * （模拟后端把 D1 里已写入、还没构建的也算进去）
 */
function fakeApi(spec: Record<string, { provides?: string[]; needs?: string[]; fail?: string }>, opts: { buildFails?: boolean } = {}) {
  const provided = new Set<string>()
  const calls: Array<{ source: string; opts: unknown }> = []
  const api: BatchApi & { builds: number } = {
    builds: 0,
    installPlugin: vi.fn(async (source: string, o: unknown) => {
      calls.push({ source, opts: o })
      const s = spec[source]!
      if (s.fail) throw new ApiError(409, s.fail)
      const missing = (s.needs ?? []).filter((n) => !provided.has(n))
      if (missing.length) throw new ApiError(400, `依赖未满足：${missing.join('、')}`, [], DEPENDENCIES_MISSING)
      for (const p of s.provides ?? []) provided.add(p)
      return { warnings: source === 'git:w' ? ['新增权限 r2'] : [] }
    }),
    triggerBuild: vi.fn(async () => {
      api.builds += 1
      if (opts.buildFails) throw new Error('boom')
    }),
  }
  return { api, calls }
}

describe('writeBatch', () => {
  it('逐个 build: false 写进清单，全部写完只触发一次构建', async () => {
    const { api, calls } = fakeApi({ 'git:a': {}, 'git:w': {} })
    const res = await writeBatch(
      [
        { name: 'a', source: 'git:a', acknowledgeDurableObjects: true },
        { name: 'w', source: 'git:w' },
      ],
      api,
    )
    expect(res).toEqual({ done: ['a', 'w'], failed: [], warnings: ['w：新增权限 r2'], build: { ok: true } })
    expect(calls.map((c) => c.opts)).toEqual([{ build: false, acknowledgeDurableObjects: true }, { build: false }])
    expect(api.builds).toBe(1)
  })

  it('排在提供者前面、报「依赖未满足」的，等这一轮别的写完再重试', async () => {
    // 新版本的 poster 依赖 render-kit 新版本才提供的 render2：按线上清单排不出来
    const { api, calls } = fakeApi({ 'git:poster': { needs: ['render2'] }, 'git:render-kit': { provides: ['render2'] } })
    const res = await writeBatch(
      [
        { name: 'poster', source: 'git:poster' },
        { name: 'render-kit', source: 'git:render-kit' },
      ],
      api,
    )
    expect(res.done).toEqual(['render-kit', 'poster'])
    expect(res.failed).toEqual([])
    expect(calls.map((c) => c.source)).toEqual(['git:poster', 'git:render-kit', 'git:poster'])
  })

  it('一整轮都没进展就停下，如实报错；其他错误不重试', async () => {
    const { api, calls } = fakeApi({ 'git:x': { needs: ['nobody'] }, 'git:bad': { fail: '冲突' }, 'git:ok': {} })
    const res = await writeBatch(
      [
        { name: 'x', source: 'git:x' },
        { name: 'bad', source: 'git:bad' },
        { name: 'ok', source: 'git:ok' },
      ],
      api,
    )
    expect(res.done).toEqual(['ok'])
    expect(res.failed).toEqual(['bad：冲突', 'x：依赖未满足：nobody'])
    expect(calls.map((c) => c.source)).toEqual(['git:x', 'git:bad', 'git:ok', 'git:x'])
    expect(api.builds).toBe(1)
  })

  it('一个都没写进去就不触发构建；构建触发失败单独报', async () => {
    const none = fakeApi({ 'git:bad': { fail: '冲突' } })
    expect((await writeBatch([{ name: 'bad', source: 'git:bad' }], none.api)).build).toBeNull()
    expect(none.api.builds).toBe(0)

    const broken = fakeApi({ 'git:a': {} }, { buildFails: true })
    expect((await writeBatch([{ name: 'a', source: 'git:a' }], broken.api)).build).toEqual({ ok: false, error: 'boom' })
  })
})
