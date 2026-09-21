import { readFileSync } from 'node:fs'
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

  it('配置缺失 id 但环境变量有 CF_* 时自动补齐，不产生 warnings', () => {
    process.env.CF_KV_ID = 'env-kv-id'
    process.env.CF_D1_ID = 'env-d1-id'
    process.env.CF_R2_NAME = 'env-r2-name'
    try {
      const { bindings, warnings } = deriveBindings({
        kv_namespaces: [{ binding: 'KV' }],
        d1_databases: [{ binding: 'DB' }],
        r2_buckets: [{ binding: 'R2' }],
      })
      expect(bindings.kv.namespaceId).toBe('env-kv-id')
      expect(bindings.d1.databaseId).toBe('env-d1-id')
      expect(bindings.r2?.bucketName).toBe('env-r2-name')
      expect(warnings).toEqual([])
    } finally {
      delete process.env.CF_KV_ID
      delete process.env.CF_D1_ID
      delete process.env.CF_R2_NAME
    }
  })

  it('CF_D1_ID / CF_R2_NAME 为 none 时视为「显式跳过」，不当作资源标识也不报缺 id', () => {
    process.env.CF_D1_ID = 'none'
    process.env.CF_R2_NAME = 'none'
    try {
      const { bindings, warnings } = deriveBindings({
        kv_namespaces: [{ binding: 'KV', id: 'kv1' }],
        d1_databases: [{ binding: 'DB', database_name: 'qqbot' }],
        r2_buckets: [{ binding: 'R2' }],
      })
      expect(bindings.d1.databaseId).toBe(PROVISIONED_PLACEHOLDER)
      expect(bindings.r2?.bucketName).toBe(PROVISIONED_PLACEHOLDER)
      expect(warnings).toEqual([])
    } finally {
      delete process.env.CF_D1_ID
      delete process.env.CF_R2_NAME
    }
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

  it('自动注入推导得到的资源 ID 与自定义域名 routes', () => {
    process.env.CF_CUSTOM_DOMAIN = 'bot.test.com'
    try {
      const templateBase = {
        name: 'bot',
        kv_namespaces: [{ binding: 'KV' }],
        d1_databases: [{ binding: 'DB', database_name: 'qqbot' }],
        r2_buckets: [{ binding: 'R2' }],
        workers_dev: true,
      }
      const out = generateWranglerConfig({
        base: templateBase,
        projection: makeProjection(),
        mainPath: 'out/index.js',
        bindings: {
          kv: { binding: 'KV', namespaceId: 'injected-kv-id' },
          d1: { binding: 'DB', databaseId: 'injected-d1-id' },
          r2: { binding: 'R2', bucketName: 'injected-r2-bucket' },
        },
      })
      expect(out.kv_namespaces?.[0]?.id).toBe('injected-kv-id')
      expect(out.d1_databases?.[0]?.database_id).toBe('injected-d1-id')
      expect(out.r2_buckets?.[0]?.bucket_name).toBe('injected-r2-bucket')
      expect(out.routes).toEqual([{ pattern: 'bot.test.com', custom_domain: true }])
      expect(out.workers_dev).toBe(true)
    } finally {
      delete process.env.CF_CUSTOM_DOMAIN
    }
  })

  it('CF_WORKER_NAME 动态重写 Worker 脚本名与 vars.WORKER_NAME', () => {
    process.env.CF_WORKER_NAME = 'my-custom-bot'
    try {
      const out = generateWranglerConfig({
        base: { name: 'qqbot', vars: { WORKER_NAME: 'qqbot' } },
        projection: makeProjection(),
        mainPath: 'out/index.js',
      })
      expect(out.name).toBe('my-custom-bot')
      expect(out.vars?.WORKER_NAME).toBe('my-custom-bot')
    } finally {
      delete process.env.CF_WORKER_NAME
    }
  })

  it('未配置或跳过 D1 与 R2 时，从配置中安全剥离对应字段', () => {
    const templateBase = {
      name: 'bot',
      kv_namespaces: [{ binding: 'KV', id: 'kv-id' }],
      d1_databases: [{ binding: 'DB', database_name: 'qqbot' }],
      r2_buckets: [{ binding: 'R2', bucket_name: 'qqbot-artifacts' }],
    }
    const out = generateWranglerConfig({
      base: templateBase,
      projection: makeProjection(),
      mainPath: 'out/index.js',
      bindings: {
        kv: { binding: 'KV', namespaceId: 'kv-id' },
        d1: { binding: 'DB', databaseId: PROVISIONED_PLACEHOLDER },
        r2: { binding: 'R2', bucketName: PROVISIONED_PLACEHOLDER },
      },
    })
    expect(out.kv_namespaces?.[0]?.id).toBe('kv-id')
    expect(out.d1_databases).toBeUndefined()
    expect(out.r2_buckets).toBeUndefined()
  })

  // 回归：apps/seed/wrangler.jsonc 曾把 R2 桶名硬编码在模板里，导致下面的剥离分支永远进不去——
  // 引导流程里「R2 不可用 → 降级为不绑定」实际不生效，未激活 R2 的账户会卡在首次部署。
  it('模板只声明 binding 名、环境变量又没给时，剥离 D1 与 R2（R2 降级回归）', () => {
    const templateBase = {
      name: 'qqbot',
      kv_namespaces: [{ binding: 'KV' }],
      d1_databases: [{ binding: 'DB', database_name: 'qqbot' }],
      r2_buckets: [{ binding: 'R2' }],
      vars: { WORKER_NAME: 'qqbot' },
    }
    process.env.CF_KV_ID = 'kv-real'
    delete process.env.CF_D1_ID
    delete process.env.CF_R2_NAME
    try {
      const { bindings } = deriveBindings(templateBase)
      const out = generateWranglerConfig({
        base: templateBase,
        projection: makeProjection(),
        mainPath: 'out/index.js',
        bindings,
      })
      expect(out.kv_namespaces?.[0]?.id).toBe('kv-real')
      expect(out.d1_databases).toBeUndefined()
      expect(out.r2_buckets).toBeUndefined()
    } finally {
      delete process.env.CF_KV_ID
    }
  })

  it('CF_R2_NAME=none 时即使模板硬编码了桶名也剥离 R2（哨兵优先于模板值）', () => {
    const templateBase = {
      name: 'qqbot',
      kv_namespaces: [{ binding: 'KV', id: 'kv1' }],
      r2_buckets: [{ binding: 'R2', bucket_name: 'qqbot-artifacts' }],
    }
    process.env.CF_R2_NAME = 'none'
    try {
      const { bindings } = deriveBindings(templateBase)
      const out = generateWranglerConfig({
        base: templateBase,
        projection: makeProjection(),
        mainPath: 'out/index.js',
        bindings,
      })
      expect(out.r2_buckets).toBeUndefined()
    } finally {
      delete process.env.CF_R2_NAME
    }
  })

  // 跨包守门：apps/seed/wrangler.jsonc 是「模板只声明 binding 名、资源标识一律由环境注入」的
  // 唯一范本。一旦有人在模板里写回 bucket_name / database_id / id，上面那条降级路径就会失效，
  // 而未激活 R2 的账户只会在首次部署时才炸——所以在这里把契约钉死。
  it('种子模板只声明 binding 名，不硬编码任何资源标识', () => {
    const seedTemplate = parseJsonc<{
      kv_namespaces?: Array<Record<string, unknown>>
      d1_databases?: Array<Record<string, unknown>>
      r2_buckets?: Array<Record<string, unknown>>
    }>(readFileSync(new URL('../../../apps/seed/wrangler.jsonc', import.meta.url), 'utf8'))

    expect(seedTemplate.kv_namespaces?.[0]).toEqual({ binding: 'KV' })
    expect(seedTemplate.r2_buckets?.[0]).toEqual({ binding: 'R2' })
    expect(seedTemplate.d1_databases?.[0]).toEqual({ binding: 'DB', database_name: 'qqbot' })
  })
})
