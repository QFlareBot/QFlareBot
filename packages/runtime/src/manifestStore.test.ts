import { describe, expect, it } from 'vitest'
import {
  deleteManifestPlugin,
  getManifestPlugin,
  insertInstall,
  listInstalls,
  listManifestPlugins,
  manifestHash,
  markPendingBuilding,
  mergeManifestPlugins,
  parseGitSource,
  rawManifestUrl,
  resetManifestSchema,
  updateInstallByBuildUuid,
  upsertManifestPlugin,
  type InstallRecord,
} from './manifestStore.js'
import { createManifestD1 } from './testing/mocks.js'

const d1 = createManifestD1()
const reset = () => {
  d1.plugins.clear()
  d1.installs.clear()
  resetManifestSchema()
}

describe('parseGitSource', () => {
  it('解析 owner/repo@sha 与可选子目录', () => {
    expect(parseGitSource('git:me/qqbot-plugin-hello@a1b2c3d4e5')).toEqual({ owner: 'me', repo: 'qqbot-plugin-hello', sha: 'a1b2c3d4e5' })
    expect(parseGitSource('git:me/qqbot-plugin-hello@a1b2c3d4#packages/plugin')).toEqual({
      owner: 'me',
      repo: 'qqbot-plugin-hello',
      sha: 'a1b2c3d4',
      subdir: 'packages/plugin',
    })
    expect(parseGitSource('  git:me/repo@a1b2c3d4 ')).toMatchObject({ owner: 'me' })
  })

  it('拒绝非法格式与不安全子目录', () => {
    expect(parseGitSource('git:me/repo')).toBeNull()
    expect(parseGitSource('git:me/repo@zzz')).toBeNull()
    expect(parseGitSource('git:me/repo@ab')).toBeNull()
    expect(parseGitSource('git:me/repo@a1b2c3d4#/../etc')).toBeNull()
    expect(parseGitSource('npm:qqbot-plugin-hello')).toBeNull()
  })

  it('声明清单 raw 地址', () => {
    expect(rawManifestUrl({ owner: 'me', repo: 'r', sha: 'a1b2c3d4' })).toBe('https://raw.githubusercontent.com/me/r/a1b2c3d4/manifest.json')
    expect(rawManifestUrl({ owner: 'me', repo: 'r', sha: 'a1b2c3d4', subdir: 'pkgs/p' })).toBe(
      'https://raw.githubusercontent.com/me/r/a1b2c3d4/pkgs/p/manifest.json',
    )
    expect(rawManifestUrl({ owner: 'me', repo: 'r', sha: 'a1b2c3d4' }, true)).toBe(
      'https://raw.githubusercontent.com/me/r/a1b2c3d4/dist/manifest.json',
    )
  })
})

describe('mergeManifestPlugins', () => {
  it('D1 覆盖同名内置插件，独有插件按名追加', () => {
    const base = [
      { name: 'echo', version: '0.1.0', source: 'file:../../plugins/echo/dist/plugin.js' },
      { name: 'image', version: '0.1.0', source: 'file:../../plugins/image/dist/plugin.js' },
    ]
    const overrides = [
      { name: 'zzz', version: '1.0.0', source: 'git:me/zzz@a1b2c3d4' },
      { name: 'echo', version: '2.0.0', source: 'git:me/echo@b2c3d4e5' },
    ]
    expect(mergeManifestPlugins(base, overrides)).toEqual([
      { name: 'echo', version: '2.0.0', source: 'git:me/echo@b2c3d4e5' },
      { name: 'image', version: '0.1.0', source: 'file:../../plugins/image/dist/plugin.js' },
      { name: 'zzz', version: '1.0.0', source: 'git:me/zzz@a1b2c3d4' },
    ])
  })

  it('空覆盖时原样返回', () => {
    const base = [{ name: 'echo', version: '0.1.0', source: 'file:x' }]
    expect(mergeManifestPlugins(base, [])).toEqual(base)
  })
})

describe('manifestHash', () => {
  it('与顺序无关，内容变化即变化', async () => {
    const a = { name: 'echo', version: '1.0.0', source: 'git:me/echo@a1b2c3d4' }
    const b = { name: 'image', version: '1.0.0', source: 'git:me/image@b2c3d4e5' }
    expect(await manifestHash([a, b])).toBe(await manifestHash([b, a]))
    expect(await manifestHash([a, b])).not.toBe(await manifestHash([a, { ...b, version: '1.0.1' }]))
  })
})

describe('存储', () => {
  it('插件条目 upsert/查/删，added_at 保留', async () => {
    reset()
    await upsertManifestPlugin(d1, { name: 'echo', version: '1.0.0', source: 'git:me/echo@a1b2c3d4' }, 1000)
    await upsertManifestPlugin(d1, { name: 'echo', version: '2.0.0', source: 'git:me/echo@b2c3d4e5' }, 2000)
    const row = (await d1.plugins.get('echo')) as { added_at: number; updated_at: number }
    expect(row.added_at).toBe(1000)
    expect(row.updated_at).toBe(2000)
    expect(await getManifestPlugin(d1, 'echo')).toEqual({ name: 'echo', version: '2.0.0', source: 'git:me/echo@b2c3d4e5' })
    expect((await listManifestPlugins(d1)).map((p) => p.name)).toEqual(['echo'])

    await upsertManifestPlugin(d1, { name: 'image', version: '1.0.0', source: 'git:me/image@b2c3d4e5' }, 1500)
    expect((await listManifestPlugins(d1)).map((p) => p.name)).toEqual(['echo', 'image'])

    await deleteManifestPlugin(d1, 'echo')
    expect(await getManifestPlugin(d1, 'echo')).toBeNull()
  })

  it('安装账本：写入、pending 并入构建、按 build_uuid 同步状态', async () => {
    reset()
    const hash = await manifestHash([{ name: 'echo', version: '1.0.0', source: 'git:me/echo@a1b2c3d4' }])
    const install = await insertInstall(d1, { action: 'install', name: 'echo', source: 'git:me/echo@a1b2c3d4', manifestHash: hash, status: 'pending' })
    expect(install.status).toBe('pending')

    await markPendingBuilding(d1, hash, 'build-1')
    const build = await insertInstall(d1, { action: 'build', name: null, source: null, manifestHash: hash, status: 'building', buildUuid: 'build-1' })

    const rows = await listInstalls(d1)
    expect(rows.every((r) => r.status === 'building' && r.buildUuid === 'build-1')).toBe(true)

    await updateInstallByBuildUuid(d1, 'build-1', { status: 'ok', cfStatus: 'success', commitHash: 'a'.repeat(40) })
    const done = await listInstalls(d1)
    expect(done.map((r: InstallRecord) => r.status)).toEqual(['ok', 'ok'])
    expect(done[0]).toMatchObject({ commitHash: 'a'.repeat(40), cfStatus: 'success' })
    expect(done.map((r) => r.id).sort()).toEqual([install.id, build.id].sort())
  })

  it('失败构建带错误信息', async () => {
    reset()
    await insertInstall(d1, { action: 'build', name: null, source: null, manifestHash: 'h', status: 'failed', error: 'HTTP 502' })
    const [row] = await listInstalls(d1)
    expect(row).toMatchObject({ status: 'failed', error: 'HTTP 502' })
  })
})
