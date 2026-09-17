import { describe, expect, it } from 'vitest'
import { makeProjection } from './__fixtures__/manifest.js'
import { parseJsonc, stripJsonComments } from './jsonc.js'
import { PROVISIONED_PLACEHOLDER, deriveBindings, generateWranglerConfig } from './wrangler.js'

describe('jsonc', () => {
  it('去掉行注释、块注释与尾随逗号，保留字符串内容', () => {
    const text = `{
  // 行注释
  "name": "bot", /* 块注释 */
  "url": "http://x/y", // 字符串内的 // 不受影响
  "arr": [1, 2, ],
  "esc": "a\\"b // 仍在字符串内",
  "nested": { "k": "v", },
}`
    expect(parseJsonc(text)).toEqual({
      name: 'bot',
      url: 'http://x/y',
      arr: [1, 2],
      esc: 'a"b // 仍在字符串内',
      nested: { k: 'v' },
    })
  })

  it('注释替换为空白，保留行号', () => {
    const out = stripJsonComments('{\n/* a\nb */ "x": 1 // c\n}')
    expect(out.split('\n')).toHaveLength(4)
    expect(JSON.parse(out)).toEqual({ x: 1 })
  })
})

describe('deriveBindings', () => {
  it('从 wrangler 配置推导 bindings，非字符串 vars 序列化', () => {
    const { bindings, warnings } = deriveBindings({
      kv_namespaces: [{ binding: 'KV', id: 'kv1' }],
      d1_databases: [{ binding: 'DB', database_id: 'db1' }],
      r2_buckets: [{ binding: 'R2', bucket_name: 'b' }],
      vars: { A: 'x', B: { c: 1 } },
    })
    expect(bindings).toEqual({
      kv: { binding: 'KV', namespaceId: 'kv1' },
      d1: { binding: 'DB', databaseId: 'db1' },
      r2: { binding: 'R2', bucketName: 'b' },
      vars: { A: 'x', B: '{"c":1}' },
    })
    expect(warnings).toEqual([])
  })

  it('缺 id 时用占位符并给出提醒', () => {
    const { bindings, warnings } = deriveBindings({
      kv_namespaces: [{ binding: 'KV' }],
      d1_databases: [{ binding: 'DB' }],
    })
    expect(bindings.kv.namespaceId).toBe(PROVISIONED_PLACEHOLDER)
    expect(bindings.d1.databaseId).toBe(PROVISIONED_PLACEHOLDER)
    expect(bindings).not.toHaveProperty('r2')
    expect(bindings).not.toHaveProperty('vars')
    expect(warnings).toHaveLength(2)
  })

  it('完全缺失时使用默认 binding 名', () => {
    const { bindings, warnings } = deriveBindings({})
    expect(bindings.kv.binding).toBe('KV')
    expect(bindings.d1.binding).toBe('DB')
    expect(warnings.length).toBeGreaterThan(0)
  })
})

describe('generateWranglerConfig', () => {
  const base = {
    name: 'bot',
    main: 'src/index.ts',
    compatibility_date: '2025-01-01',
    kv_namespaces: [{ binding: 'KV', id: 'kv1' }],
    durable_objects: { bindings: [{ name: 'OWN', class_name: 'Own' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['Own'] }],
  }

  it('指向投影输出、关闭打包、追加插件 DO 与迁移', () => {
    const projection = makeProjection({
      hash: '0123456789abcdef'.repeat(4),
      metadata: {
        ...makeProjection().metadata,
        exports: { P_foo_Game: { type: 'durable-object', storage: 'sqlite' } },
      },
    })
    const out = generateWranglerConfig({ base, projection, mainPath: '.projected/index.js' })
    expect(out.name).toBe('bot')
    expect(out.main).toBe('.projected/index.js')
    expect(out.no_bundle).toBe(true)
    expect(out.rules).toEqual([{ type: 'ESModule', globs: ['**/*.js'] }])
    expect(out.compatibility_date).toBe('2025-01-01')
    expect(out.durable_objects).toEqual({
      bindings: [
        { name: 'OWN', class_name: 'Own' },
        { name: 'P_foo_Game', class_name: 'P_foo_Game' },
      ],
    })
    expect(out.migrations).toEqual([
      { tag: 'v1', new_sqlite_classes: ['Own'] },
      { tag: 'p-01234567', new_sqlite_classes: ['P_foo_Game'] },
    ])
  })

  it('无插件 DO 时不追加；缺 compatibility_date 时从投影补齐', () => {
    const out = generateWranglerConfig({
      base: { name: 'bot' },
      projection: makeProjection(),
      mainPath: 'out/index.js',
    })
    expect(out).not.toHaveProperty('durable_objects')
    expect(out).not.toHaveProperty('migrations')
    expect(out.compatibility_date).toBe('2025-09-01')
  })

  it('重复生成时不会叠加旧的插件 DO 绑定与迁移', () => {
    const projection = makeProjection({
      metadata: { ...makeProjection().metadata, exports: { P_x_Y: { type: 'durable-object', storage: 'sqlite' } } },
    })
    const once = generateWranglerConfig({ base, projection, mainPath: 'o/index.js' })
    const twice = generateWranglerConfig({ base: once, projection, mainPath: 'o/index.js' })
    expect(twice.durable_objects).toEqual(once.durable_objects)
    expect(twice.migrations).toEqual(once.migrations)
  })
})
