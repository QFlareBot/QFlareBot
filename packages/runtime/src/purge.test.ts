/**
 * 卸载清数据与存储视图。走真实的 admin 路由，顺带验证接线到位。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { resetEventsSchema } from './events.js'
import { resetLifecycle } from './lifecycle.js'
import { addPendingCleanup, insertInstall, resetManifestSchema, upsertManifestPlugin } from './manifestStore.js'
import {
  describeRemaining,
  knownPluginNames,
  listPluginTables,
  ownerOfTable,
  purgeComplete,
  purgePluginData,
} from './purge.js'
import { PluginRegistry } from './registry.js'
import { resetSnapshotCache } from './store.js'
import { createRuntime } from './runtime.js'
import { createEnv, createExecutionContext, createManifestD1 } from './testing/mocks.js'
import type { RuntimeEnv } from './types.js'

const BASE = 'https://bot.test'
const ADMIN = 'admin-token'
const SOURCE = 'git:me/qqbot-plugin-hello@a1b2c3d4e5'

/** 给插件 hello 铺一份三种存储都有的数据，外加一个同前缀的邻居 hello2 */
async function seedData(env: RuntimeEnv): Promise<void> {
  await env.KV.put('p:hello:a', '1')
  await env.KV.put('p:hello:b', '2')
  await env.KV.put('rt:installed:hello', '1.0.0')
  await env.KV.put('p:hello2:a', 'neighbour')
  await env.R2!.put('p/hello/img.png', 'PNG')
  await env.R2!.put('p/hello2/img.png', 'PNG')
  const db = env.DB as unknown as { tables: Map<string, number> }
  db.tables.set('p_hello_notes', 3)
  db.tables.set('p_hello_tags', 1)
  db.tables.set('p_hello2_notes', 7)
  db.tables.set('rt_installs', 99)
}

function setup(plugins: Parameters<typeof createRuntime>[0]['plugins'] = []) {
  const runtime = createRuntime({ plugins })
  const env = createEnv({ DB: createManifestD1() })
  const call = (path: string, init: RequestInit = {}) =>
    runtime.fetch!(new Request(`${BASE}${path}`, init), env, createExecutionContext())
  const admin = { authorization: `Bearer ${ADMIN}` }
  return { call, env, admin }
}

beforeEach(() => {
  resetManifestSchema()
  resetSnapshotCache()
  resetLifecycle()
  resetEventsSchema()
})

describe('按前缀枚举插件的表', () => {
  it('不会把 hello2 的表算到 hello 头上——SQL 的 LIKE 会把 `_` 当通配符', async () => {
    const { env } = setup()
    await seedData(env)

    expect(await listPluginTables(env.DB, 'hello')).toEqual(['p_hello_notes', 'p_hello_tags'])
    expect(await listPluginTables(env.DB, 'hello2')).toEqual(['p_hello2_notes'])
  })

  it('不带插件名时列出所有插件表，但不含框架自己的表', async () => {
    const { env } = setup()
    await seedData(env)

    expect(await listPluginTables(env.DB)).toEqual(['p_hello2_notes', 'p_hello_notes', 'p_hello_tags'])
  })

  it('归属判定拿已知插件名匹配，插件名自己带下划线也不会错配', () => {
    expect(ownerOfTable('p_hello2_notes', ['hello', 'hello2'])).toBe('hello2')
    expect(ownerOfTable('p_my_plugin_notes', ['my_plugin'])).toBe('my_plugin')
    expect(ownerOfTable('p_ghost_notes', ['hello'])).toBeNull()
  })

  it('两个插件名都能匹配同一张表时取更长的那个', () => {
    // p_my_plugin_notes 既像 my 的 plugin_notes 表，也像 my_plugin 的 notes 表
    expect(ownerOfTable('p_my_plugin_notes', ['my', 'my_plugin'])).toBe('my_plugin')
    expect(ownerOfTable('p_my_plugin_notes', ['my'])).toBe('my')
  })
})

describe('purgePluginData', () => {
  it('三种存储一起清，且只清自己的', async () => {
    const { env } = setup()
    await seedData(env)

    const report = await purgePluginData('hello', env)

    expect(report).toEqual({
      kvKeys: 2,
      tables: ['p_hello_notes', 'p_hello_tags'],
      r2Objects: 1,
      skippedTables: [],
      kvRemaining: 0,
      r2Remaining: 0,
      tablesRemaining: 0,
    })
    expect(await env.KV.get('p:hello:a')).toBeNull()
    expect(await env.KV.get('p:hello2:a')).toBe('neighbour')
    expect([...(env.R2 as unknown as { store: Map<string, string> }).store.keys()]).toEqual(['p/hello2/img.png'])
    expect(await listPluginTables(env.DB)).toEqual(['p_hello2_notes'])
  })

  it('表前缀碰撞时不删邻居的表：my-plugin 与 my_plugin 都落到 p_my_plugin_', async () => {
    const { env } = setup()
    const db = env.DB as unknown as { tables: Map<string, number> }
    db.tables.set('p_my_plugin_notes', 5)
    await env.KV.put('p:my-plugin:a', '1')

    // 不认识邻居时无从判断归属：表名归谁看不出来，所以必须留着（宁可留孤儿，DROP 不可逆）
    const guarded = await purgePluginData('my-plugin', env, ['my_plugin'])
    expect(guarded.tables).toEqual([])
    expect(guarded.skippedTables).toEqual(['p_my_plugin_notes'])
    expect(await listPluginTables(env.DB)).toEqual(['p_my_plugin_notes'])
    // KV 前缀用的是原始插件名（p:my-plugin:），不存在碰撞，照常清掉
    expect(guarded.kvKeys).toBe(1)
    expect(await env.KV.get('p:my-plugin:a')).toBeNull()

    // 没有同名前缀的邻居时，正常删掉
    const clean = await purgePluginData('my-plugin', env, ['other'])
    expect(clean.tables).toEqual(['p_my_plugin_notes'])
    expect(clean.skippedTables).toEqual([])
    expect(await listPluginTables(env.DB)).toEqual([])
  })
})

describe('purgePluginData 一次只删一批', () => {
  const tablesOf = (env: RuntimeEnv) => (env.DB as unknown as { tables: Map<string, number> }).tables
  const r2Of = (env: RuntimeEnv) => (env.R2 as unknown as { store: Map<string, string> }).store

  it('KV 键多：每次最多删 500 个，报出还剩多少，删到 0 为止', async () => {
    const { env } = setup()
    for (let i = 0; i < 1200; i++) await env.KV.put(`p:hello:k${i}`, '1')

    const first = await purgePluginData('hello', env)
    expect(first).toMatchObject({ kvKeys: 500, kvRemaining: 700 })
    expect(purgeComplete(first)).toBe(false)
    expect(describeRemaining(first)).toBe('还剩 700 个 KV 键')
    expect(await purgePluginData('hello', env)).toMatchObject({ kvKeys: 500, kvRemaining: 200 })
    const last = await purgePluginData('hello', env)
    expect(last).toMatchObject({ kvKeys: 200, kvRemaining: 0 })
    expect(purgeComplete(last)).toBe(true)
    expect(describeRemaining(last)).toBeNull()
  })

  it('表多：每次最多 DROP 20 张；R2 翻到页数上限还没列完时按「至少还剩一个」报', async () => {
    const { env } = setup()
    for (let i = 0; i < 25; i++) tablesOf(env).set(`p_hello_t${String(i).padStart(2, '0')}`, 1)
    // 假 R2 每页 2 个、最多翻 20 页：45 个对象第一次只列得到 40 个
    for (let i = 0; i < 45; i++) await env.R2!.put(`p/hello/o${String(i).padStart(2, '0')}`, 'x')

    const first = await purgePluginData('hello', env)
    expect(first.tables).toHaveLength(20)
    expect(first).toMatchObject({ tablesRemaining: 5, r2Objects: 40, r2Remaining: 1 })
    const second = await purgePluginData('hello', env)
    expect(second).toMatchObject({ tables: expect.any(Array), tablesRemaining: 0, r2Objects: 5, r2Remaining: 0 })
    expect(second.tables).toHaveLength(5)
    expect(tablesOf(env).size).toBe(0)
    expect(r2Of(env).size).toBe(0)
  })

  it('邻居名字不在任何名单里、只剩 KV 或 R2 的数据：从键名圈出来，表前缀嵌套的表不删', async () => {
    const { env } = setup()
    // game_stats 以前卸载时保留了数据，账本里也早就没它了：p_game_stats_scores 以 p_game_ 开头
    tablesOf(env).set('p_game_rooms', 1)
    tablesOf(env).set('p_game_stats_scores', 9)
    await env.KV.put('p:game_stats:x', '1')

    const viaKv = await purgePluginData('game', env)
    expect(viaKv.tables).toEqual(['p_game_rooms'])
    expect(viaKv.skippedTables).toEqual(['p_game_stats_scores'])
    expect(tablesOf(env).has('p_game_stats_scores')).toBe(true)

    // 只剩 R2 的也一样认得出
    await env.KV.delete('p:game_stats:x')
    await env.R2!.put('p/game_stats/avatar.png', 'PNG')
    const viaR2 = await purgePluginData('game', env)
    expect(viaR2.skippedTables).toEqual(['p_game_stats_scores'])
    expect(tablesOf(env).has('p_game_stats_scores')).toBe(true)

    // 反过来清 game_stats 时，game 的名字也得认：p_game_stats_scores 也可能是 game 的 {stats_scores}
    const reverse = await purgePluginData('game_stats', env, ['game'])
    expect(reverse.skippedTables).toEqual(['p_game_stats_scores'])
  })

  it('键多到圈不全邻居时不删表：自己的还没删完就留到下一批，删完了还圈不全就跳过', async () => {
    const { env } = setup()
    tablesOf(env).set('p_game_rooms', 1)
    // 20 页 × 1000 个还列不到底
    for (let i = 0; i < 20_500; i++) env.KV.store.set(`p:game:k${i}`, '1')

    const first = await purgePluginData('game', env)
    expect(first).toMatchObject({ tables: [], skippedTables: [], tablesRemaining: 1, kvKeys: 500 })
    // 剩 20000 个，刚好列得到底：邻居圈全了，表照常删
    const second = await purgePluginData('game', env)
    expect(second.tables).toEqual(['p_game_rooms'])

    // 自己没有 KV、邻居的键多到列不完：归属定不下来，只能当撞了邻居跳过，不会每批都留着没完没了
    const { env: other } = setup()
    tablesOf(other).set('p_game_rooms', 1)
    for (let i = 0; i < 20_001; i++) other.KV.store.set(`p:gamer:k${i}`, '1')
    const skipped = await purgePluginData('game', other)
    expect(skipped).toMatchObject({ tables: [], skippedTables: ['p_game_rooms'], tablesRemaining: 0, kvRemaining: 0 })
    expect(purgeComplete(skipped)).toBe(true)
  })

  it('没有表要删时不去圈邻居：不多花 KV list', async () => {
    const { env } = setup()
    await env.KV.put('p:hello:a', '1')
    const prefixes: string[] = []
    const list = env.KV.list.bind(env.KV)
    env.KV.list = ((opts: { prefix?: string }) => {
      prefixes.push(opts.prefix ?? '')
      return list(opts)
    }) as typeof env.KV.list
    await purgePluginData('hello', env)
    expect(prefixes).toEqual(['p:hello:'])
  })
})

describe('knownPluginNames：四处共用的「已知插件名」', () => {
  it('注册表、D1 清单、账本里出现过的（DISTINCT）、待收尾的都算', async () => {
    const db = createManifestD1()
    const env = createEnv({ DB: db })
    await upsertManifestPlugin(db, { name: 'queued', version: '1.0.0', source: SOURCE })
    await insertInstall(db, { action: 'uninstall', name: 'gone', source: SOURCE, manifestHash: 'h', status: 'ok' })
    await insertInstall(db, { action: 'install', name: 'gone', source: SOURCE, manifestHash: 'h', status: 'ok' })
    await insertInstall(db, { action: 'build', name: null, source: null, manifestHash: 'h', status: 'ok' })
    await addPendingCleanup(db, 'leaving', true)
    const registry = new PluginRegistry([{ name: 'live', version: '1.0.0' }])

    expect([...(await knownPluginNames(env, registry))].sort()).toEqual(['gone', 'leaving', 'live', 'queued'])
  })
})

describe('DELETE /admin/manifest/plugins/:name', () => {
  it('默认保留数据，但一定清掉 onInstall 标记——否则重装后不建表', async () => {
    const { call, env, admin } = setup()
    await seedData(env)
    await upsertManifestPlugin(env.DB!, { name: 'hello', version: '1.0.0', source: SOURCE })

    const res = await call('/admin/manifest/plugins/hello', { method: 'DELETE', headers: admin })
    const body = (await res.json()) as { data: { purged: boolean } }

    expect(res.status).toBe(200)
    expect(body.data.purged).toBe(false)
    expect(await env.KV.get('p:hello:a')).toBe('1')
    expect(await env.KV.get('rt:installed:hello')).toBeNull()
  })

  it('purge=true 时连数据一起清', async () => {
    const { call, env, admin } = setup()
    await seedData(env)
    await upsertManifestPlugin(env.DB!, { name: 'hello', version: '1.0.0', source: SOURCE })

    const res = await call('/admin/manifest/plugins/hello?purge=true', { method: 'DELETE', headers: admin })
    const body = (await res.json()) as { data: { purged: boolean; kvKeys: number; tables: string[]; r2Objects: number } }

    expect(body.data).toMatchObject({ purged: true, kvKeys: 2, r2Objects: 1 })
    expect(body.data.tables).toEqual(['p_hello_notes', 'p_hello_tags'])
    expect(await env.KV.get('p:hello:a')).toBeNull()
    expect(await listPluginTables(env.DB)).toEqual(['p_hello2_notes'])
  })

  it('先给插件自己 onUninstall 的机会，并把 purgeData 透传进去', async () => {
    const seen: { purgeData: boolean }[] = []
    const { call, env, admin } = setup([
      { name: 'hello', version: '1.0.0', hooks: { onUninstall: (_ctx, options) => void seen.push(options) } },
    ])
    await upsertManifestPlugin(env.DB!, { name: 'hello', version: '1.0.0', source: SOURCE })

    const res = await call('/admin/manifest/plugins/hello?purge=true', { method: 'DELETE', headers: admin })

    expect(seen).toEqual([{ purgeData: true }])
    expect((await res.json() as { data: { hook: string } }).data.hook).toBe('ok')
  })

  it('钩子抛错不挡兜底清理——插件写坏了不该让数据永远清不掉', async () => {
    const { call, env, admin } = setup([
      {
        name: 'hello',
        version: '1.0.0',
        hooks: {
          onUninstall: () => {
            throw new Error('插件自己炸了')
          },
        },
      },
    ])
    await seedData(env)
    await upsertManifestPlugin(env.DB!, { name: 'hello', version: '1.0.0', source: SOURCE })

    const res = await call('/admin/manifest/plugins/hello?purge=true', { method: 'DELETE', headers: admin })
    const body = (await res.json()) as { data: { hook: string; hookError: string; kvKeys: number } }

    expect(body.data.hook).toBe('failed')
    expect(body.data.hookError).toMatch(/插件自己炸了/)
    expect(body.data.kvKeys).toBe(2)
    expect(await env.KV.get('p:hello:a')).toBeNull()
  })
})

describe('GET /admin/storage', () => {
  it('装着的插件列用量，卸载后残留的列成孤儿', async () => {
    const { call, env, admin } = setup([{ name: 'hello2', version: '1.0.0' }])
    await seedData(env)

    const body = (await (await call('/admin/storage', { headers: admin })).json()) as {
      plugins: { plugin: string; kvKeys: number; tables: { name: string; rows: number }[]; r2Objects: number }[]
      orphans: { plugin: string; kvKeys: number }[]
    }

    expect(body.plugins.map((p) => p.plugin)).toEqual(['hello2'])
    expect(body.plugins[0]).toMatchObject({ kvKeys: 1, r2Objects: 1 })
    expect(body.plugins[0]!.tables).toEqual([{ name: 'p_hello2_notes', rows: 7 }])
    // hello 没装，但 KV/R2 里还留着键，反推得出名字
    expect(body.orphans.map((o) => o.plugin)).toEqual(['hello'])
    expect(body.orphans[0]!.kvKeys).toBe(2)
  })

  it('认不出归属的表单独列出来，不会被算进任何插件', async () => {
    const { call, env, admin } = setup([{ name: 'hello2', version: '1.0.0' }])
    await seedData(env)
    ;(env.DB as unknown as { tables: Map<string, number> }).tables.set('p_ghost_data', 1)

    const body = (await (await call('/admin/storage', { headers: admin })).json()) as {
      plugins: { plugin: string; tables: { name: string }[] }[]
      unattributedTables: string[]
    }

    expect(body.unattributedTables).toEqual(['p_ghost_data'])
    expect(body.plugins.flatMap((p) => p.tables.map((t) => t.name))).toEqual(['p_hello2_notes'])
  })

  it('孤儿数据可以单独清掉', async () => {
    const { call, env, admin } = setup([{ name: 'hello2', version: '1.0.0' }])
    await seedData(env)

    const res = await call('/admin/storage/orphans/hello', { method: 'DELETE', headers: admin })

    expect(await res.json()).toMatchObject({ ok: true, plugin: 'hello', kvKeys: 2, r2Objects: 1 })
    expect(await listPluginTables(env.DB)).toEqual(['p_hello2_notes'])
  })

  it('还装着的插件不让用孤儿端点清，避免拿它当后门删活数据', async () => {
    const { call, env, admin } = setup([{ name: 'hello2', version: '1.0.0' }])
    await seedData(env)

    const res = await call('/admin/storage/orphans/hello2', { method: 'DELETE', headers: admin })

    expect(res.status).toBe(409)
    expect(await env.KV.get('p:hello2:a')).toBe('neighbour')
  })

  it('一次清不完：告诉面板还剩多少、再点一次；点到 done 为止', async () => {
    const { call, env, admin } = setup()
    for (let i = 0; i < 1200; i++) await env.KV.put(`p:hello:k${i}`, '1')
    const purge = async () =>
      (await (await call('/admin/storage/orphans/hello', { method: 'DELETE', headers: admin })).json()) as Record<string, unknown>

    expect(await purge()).toMatchObject({ ok: true, done: false, kvKeys: 500, kvRemaining: 700, message: expect.stringContaining('再点一次') })
    expect(await purge()).toMatchObject({ done: false, kvRemaining: 200 })
    const last = await purge()
    expect(last).toMatchObject({ done: true, kvKeys: 200, kvRemaining: 0 })
    expect(last.message).toBeUndefined()
  })

  it('清到一半出错：不再是笼统的 500，说清楚再点一次会接着清', async () => {
    const { call, env, admin } = setup()
    await seedData(env)
    env.KV.delete = (async () => {
      throw new Error('KV delete() limit exceeded for the day.')
    }) as typeof env.KV.delete

    const res = await call('/admin/storage/orphans/hello', { method: 'DELETE', headers: admin })
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: string }).error).toMatch(/limit exceeded[\s\S]*再点一次会接着清/)
  })

  it('邻居只留在 KV 里、名字不在账本：清孤儿时它的表照样认得出、不删', async () => {
    const { call, env, admin } = setup()
    const db = env.DB as unknown as { tables: Map<string, number> }
    db.tables.set('p_game_rooms', 1)
    db.tables.set('p_game_stats_scores', 9)
    await env.KV.put('p:game_stats:x', '1')

    const body = (await (await call('/admin/storage/orphans/game', { method: 'DELETE', headers: admin })).json()) as {
      tables: string[]
      skippedTables: string[]
    }
    expect(body.tables).toEqual(['p_game_rooms'])
    expect(body.skippedTables).toEqual(['p_game_stats_scores'])
    expect(db.tables.has('p_game_stats_scores')).toBe(true)
  })
})
