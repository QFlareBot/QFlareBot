/**
 * 卸载清数据与存储视图。走真实的 admin 路由，顺带验证接线到位。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { resetEventsSchema } from './events.js'
import { resetLifecycle } from './lifecycle.js'
import { resetManifestSchema, upsertManifestPlugin } from './manifestStore.js'
import { listPluginTables, ownerOfTable, purgePluginData } from './purge.js'
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

    expect(report).toEqual({ kvKeys: 2, tables: ['p_hello_notes', 'p_hello_tags'], r2Objects: 1, skippedTables: [] })
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
})
