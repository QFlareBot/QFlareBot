import { describe, expect, it } from 'vitest'
import {
  addPendingCleanup,
  attachBuildError,
  clearPluginBuildErrors,
  deleteManifestPlugin,
  getManifestPlugin,
  insertInstall,
  listInstalls,
  listManifestPluginRecords,
  listManifestPlugins,
  listPendingCleanups,
  manifestHash,
  markPendingBuilding,
  parseGitSource,
  rawManifestUrl,
  removePendingCleanup,
  resetManifestSchema,
  sameGitRepo,
  setPluginBuildError,
  settlePendingInstalls,
  updateInstallById,
  updateInstallByBuildUuid,
  upsertManifestPlugin,
  type InstallRecord,
} from './manifestStore.js'
import { createManifestD1 } from './testing/mocks.js'

const d1 = createManifestD1()
const reset = () => {
  d1.plugins.clear()
  d1.installs.clear()
  d1.cleanups.clear()
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

describe('sameGitRepo', () => {
  it('只看 owner/repo（不分大小写）与子目录，不看 commit', () => {
    const a = parseGitSource('git:Me/Repo@a1b2c3d4')!
    expect(sameGitRepo(a, parseGitSource('git:me/repo@b2c3d4e5')!)).toBe(true)
    expect(sameGitRepo(a, parseGitSource('git:other/repo@a1b2c3d4')!)).toBe(false)
    expect(sameGitRepo(a, parseGitSource('git:me/repo@a1b2c3d4#pkgs/p')!)).toBe(false)
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

    await markPendingBuilding(d1, 'build-1')
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

  it('pending 不按哈希筛、全部并入构建：批量写入时每条存的是写它那一刻的哈希', async () => {
    reset()
    // 批量更新 a、b：两条记录的哈希各不相同，都不等于触发构建那一刻的哈希
    await insertInstall(d1, { action: 'upgrade', name: 'a', source: 'git:me/a@a1b2c3d4', manifestHash: 'h-after-a', status: 'pending' }, 1000)
    await insertInstall(d1, { action: 'upgrade', name: 'b', source: 'git:me/b@a1b2c3d4', manifestHash: 'h-after-b', status: 'pending' }, 1001)
    await markPendingBuilding(d1, 'build-2')
    const rows = await listInstalls(d1)
    expect(rows.map((r) => [r.name, r.status, r.buildUuid])).toEqual([
      ['b', 'building', 'build-2'],
      ['a', 'building', 'build-2'],
    ])
  })

  it('错误信息只补不盖：构建机回报的具体原因不被之后的「构建未成功」冲掉', async () => {
    reset()
    await insertInstall(d1, { action: 'build', name: null, source: null, manifestHash: 'h', status: 'building', buildUuid: 'b-1' })
    await attachBuildError(d1, 'b-1', '插件构建失败：foo（声明清单与源码不一致）')
    await updateInstallByBuildUuid(d1, 'b-1', { status: 'failed', cfStatus: 'fail', error: '构建未成功：fail' })
    const [row] = await listInstalls(d1)
    expect(row).toMatchObject({ status: 'failed', cfStatus: 'fail', error: '插件构建失败：foo（声明清单与源码不一致）' })
  })

  it('清单已与线上一致时 pending 直接算完成', async () => {
    reset()
    await insertInstall(d1, { action: 'uninstall', name: 'x', source: 'git:me/x@a1b2c3d4', manifestHash: 'h', status: 'pending' })
    await insertInstall(d1, { action: 'build', name: null, source: null, manifestHash: 'h', status: 'failed', error: 'boom' })
    await settlePendingInstalls(d1)
    const rows = await listInstalls(d1)
    expect(rows.map((r) => r.status).sort()).toEqual(['failed', 'ok'])
  })
})

describe('声明清单与构建错误', () => {
  const manifest = { name: 'echo', version: '1.0.0', permissions: ['kv'], services: ['greet'] } as never

  it('upsert 连声明清单一起存；换 source 时构建错误清空', async () => {
    reset()
    await upsertManifestPlugin(d1, { name: 'echo', version: '1.0.0', source: 'git:me/echo@a1b2c3d4', manifest })
    await setPluginBuildError(d1, 'echo', 'git:me/echo@a1b2c3d4', '编译失败')
    let [rec] = await listManifestPluginRecords(d1)
    expect(rec).toMatchObject({ name: 'echo', buildError: '编译失败', manifest: { services: ['greet'] } })

    await upsertManifestPlugin(d1, { name: 'echo', version: '1.0.1', source: 'git:me/echo@b2c3d4e5' })
    ;[rec] = await listManifestPluginRecords(d1)
    expect(rec).toMatchObject({ version: '1.0.1', buildError: null, manifest: null })
    // 构建机读的那三个字段不受影响
    expect(await listManifestPlugins(d1)).toEqual([{ name: 'echo', version: '1.0.1', source: 'git:me/echo@b2c3d4e5' }])
  })

  it('构建错误只记在 source 仍是报告里那一份的条目上', async () => {
    reset()
    await upsertManifestPlugin(d1, { name: 'echo', version: '2.0.0', source: 'git:me/echo@b2c3d4e5' })
    await setPluginBuildError(d1, 'echo', 'git:me/echo@a1b2c3d4', '旧版本的错误')
    expect((await listManifestPluginRecords(d1))[0]!.buildError).toBeNull()

    await setPluginBuildError(d1, 'echo', 'git:me/echo@b2c3d4e5', '新版本的错误')
    expect((await listManifestPluginRecords(d1))[0]!.buildError).toBe('新版本的错误')
    await clearPluginBuildErrors(d1)
    expect((await listManifestPluginRecords(d1))[0]!.buildError).toBeNull()
  })

  it('manifest 列是坏 JSON 时当作没有，不拖垮整个列表', async () => {
    reset()
    await upsertManifestPlugin(d1, { name: 'echo', version: '1.0.0', source: 'git:me/echo@a1b2c3d4' })
    d1.plugins.get('echo')!.manifest = '{not json'
    expect((await listManifestPluginRecords(d1))[0]!.manifest).toBeNull()
  })
})

describe('老库迁移', () => {
  it('加列之前建的表：自动补上 manifest 与 build_error，老数据照常读写', async () => {
    const legacy = createManifestD1({ legacy: true })
    resetManifestSchema()
    legacy.plugins.set('old', { name: 'old', version: '0.1.0', source: 'git:me/old@a1b2c3d4', added_at: 1, updated_at: 1 })

    const [rec] = await listManifestPluginRecords(legacy)
    expect(legacy.alters).toEqual(['manifest', 'build_error'])
    expect(rec).toMatchObject({ name: 'old', manifest: null, buildError: null })

    await upsertManifestPlugin(legacy, { name: 'new', version: '1.0.0', source: 'git:me/new@b2c3d4e5' })
    expect((await listManifestPlugins(legacy)).map((p) => p.name)).toEqual(['new', 'old'])
  })

  it('列已经在了就不再 ALTER；并发补同一列撞 duplicate column 不算失败', async () => {
    const fresh = createManifestD1()
    resetManifestSchema()
    await listManifestPlugins(fresh)
    expect(fresh.alters).toEqual([])

    // 模拟另一个 isolate 抢先补了列：PRAGMA 读到的是旧状态，ALTER 撞 duplicate column
    const racing = createManifestD1({ legacy: true })
    const realPrepare = racing.prepare.bind(racing)
    racing.prepare = ((sql: string) => {
      const stmt = realPrepare(sql)
      if (sql.startsWith('PRAGMA')) {
        const staleAll = stmt.all.bind(stmt)
        stmt.all = (async () => {
          const res = await staleAll()
          for (const c of ['manifest', 'build_error']) racing.pluginColumns.add(c)
          return { results: (res.results as Array<{ name: string }>).filter((r) => r.name !== 'manifest' && r.name !== 'build_error') }
        }) as typeof stmt.all
      }
      return stmt
    }) as typeof racing.prepare
    resetManifestSchema()
    await expect(listManifestPlugins(racing)).resolves.toEqual([])
  })
})

describe('卸载的后半段', () => {
  it('记一条待清理、可取消、按时间列出', async () => {
    reset()
    await addPendingCleanup(d1, 'b', true, 2000)
    await addPendingCleanup(d1, 'a', false, 1000)
    expect(await listPendingCleanups(d1)).toEqual([
      { name: 'a', purge: false, ts: 1000 },
      { name: 'b', purge: true, ts: 2000 },
    ])
    await removePendingCleanup(d1, 'a')
    expect((await listPendingCleanups(d1)).map((c) => c.name)).toEqual(['b'])
  })
})

describe('账本治理', () => {
  it('卡死记录按 id 收敛为失败', async () => {
    reset()
    await insertInstall(d1, { action: 'build', name: null, source: null, manifestHash: 'h', status: 'building' })
    const [row] = await listInstalls(d1)
    await updateInstallById(d1, row!.id, { status: 'failed', error: '构建状态超过 24h 未同步' })
    const [after] = await listInstalls(d1)
    expect(after).toMatchObject({ status: 'failed', error: '构建状态超过 24h 未同步' })
  })

  it('账本只保留最近 100 条', async () => {
    reset()
    for (let i = 0; i < 105; i++) {
      await insertInstall(d1, { action: 'build', name: null, source: null, manifestHash: `h${i}`, status: 'ok' }, 1_000_000 + i)
    }
    const rows = await listInstalls(d1, 200)
    expect(rows.length).toBe(100)
    // 最老的被清掉，最新的都在
    expect(rows.some((r) => r.manifestHash === 'h0')).toBe(false)
    expect(rows.some((r) => r.manifestHash === 'h104')).toBe(true)
  })
})
