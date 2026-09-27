import { describe, expect, it } from 'vitest'
import type { ManagedPlugin, ManagedPluginsResult } from '../api/types.js'
import { changeStatus, pendingChanges, undoLabel } from './pendingChanges.js'

function plugin(over: Partial<ManagedPlugin>): ManagedPlugin {
  return {
    name: 'meme',
    version: '1.0.0',
    source: 'git:a/meme@new',
    addedAt: 0,
    updatedAt: 0,
    state: 'deployed',
    live: null,
    buildError: null,
    lastRecord: null,
    manifest: null,
    ...over,
  }
}

function result(plugins: ManagedPlugin[], removing: ManagedPluginsResult['removing'] = []): ManagedPluginsResult {
  return { ok: true, hash: 'h', liveHash: 'h', inSync: false, building: false, plugins, removing }
}

describe('pendingChanges', () => {
  it('已上线的不列；没上线的安装撤销 = 从清单移除', () => {
    const list = pendingChanges(result([plugin({ state: 'deployed' }), plugin({ name: 'foo', state: 'not_deployed' })]))
    expect(list.map((c) => c.key)).toEqual(['install:foo'])
    expect(list[0]!.undo).toEqual({ type: 'remove' })
    expect(undoLabel(list[0]!)).toBe('卸载')
  })

  it('升级：线上是 D1 装的就改回那一份；覆盖内置的就从清单移除', () => {
    const list = pendingChanges(
      result([
        plugin({ state: 'differs', live: { version: '0.9.0', source: 'git:a/meme@old', from: 'd1' } }),
        plugin({ name: 'sid', state: 'differs', live: { version: '0.1.0', source: null, from: 'repo' } }),
      ]),
    )
    expect(list[0]).toMatchObject({ kind: 'upgrade', title: '升级 meme 0.9.0 → 1.0.0', undo: { type: 'reinstall', source: 'git:a/meme@old' } })
    expect(list[1]).toMatchObject({ title: '覆盖内置插件 sid 0.1.0 → 1.0.0', undo: { type: 'remove' } })
    expect(undoLabel(list[1]!)).toBe('撤销覆盖')
  })

  it('构建失败的错误带出来，状态显示「构建失败」', () => {
    const [c] = pendingChanges(
      result([], [{ name: 'old', version: '1.0.0', source: 'git:a/old@x', lastRecord: { action: 'uninstall', status: 'failed', error: 'boom', ts: 1, buildUuid: null } }]),
    )
    expect(c).toMatchObject({ kind: 'uninstall', error: 'boom', undo: { type: 'reinstall', source: 'git:a/old@x' } })
    expect(changeStatus(c!)).toEqual({ tone: 'danger', label: '构建失败' })
  })

  it('读不到清单时是空的', () => {
    expect(pendingChanges(null)).toEqual([])
  })
})
