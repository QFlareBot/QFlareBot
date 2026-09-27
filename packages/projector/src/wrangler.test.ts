import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { makeProjection } from './__fixtures__/manifest.js'
import { parseJsonc, stripJsonComments } from './jsonc.js'
import type { BaseBindings } from './types.js'
import { PROVISIONED_PLACEHOLDER, deriveBindings, generateWranglerConfig, resolveState } from './wrangler.js'

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

  // 回归：逗号与 ] / } 之间隔着注释时以前认不出是尾随逗号，JSON.parse 直接报错——
  // 照提示往 wrangler.jsonc 的 migrations 里补一项时很容易这样写
  it('尾随逗号后面跟着注释也能去掉', () => {
    expect(parseJsonc('{"a":[1, // c\n]}')).toEqual({ a: [1] })
    expect(parseJsonc('{"a":1, /* c */ }')).toEqual({ a: 1 })
    expect(parseJsonc('{"a":1, /* c */ // d\n /* e */ }')).toEqual({ a: 1 })
    expect(
      parseJsonc(`{
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["Own"] },
    { "tag": "p-foo-game", "new_sqlite_classes": ["P_foo_Game"] }, // 装 foo 时补的
  ],
}`),
    ).toEqual({
      migrations: [
        { tag: 'v1', new_sqlite_classes: ['Own'] },
        { tag: 'p-foo-game', new_sqlite_classes: ['P_foo_Game'] },
      ],
    })
  })

  it('字符串里的逗号、注释符号与括号原样保留', () => {
    expect(parseJsonc('{"a":", ]", "b":"// , }", "c":"/* , */"}')).toEqual({ a: ', ]', b: '// , }', c: '/* , */' })
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

  it('CF_KV_ID=none 不算跳过：KV 是必需资源，给出不受支持的提醒', () => {
    process.env.CF_KV_ID = 'none'
    try {
      const { bindings, warnings } = deriveBindings({ kv_namespaces: [{ binding: 'KV' }], d1_databases: [{ binding: 'DB', database_id: 'd1' }] })
      expect(bindings.kv.namespaceId).toBe(PROVISIONED_PLACEHOLDER)
      expect(warnings).toEqual([expect.stringContaining('CF_KV_ID=none 不受支持')])
    } finally {
      delete process.env.CF_KV_ID
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

  /** DO 用例需要一个已声明插件类迁移的模板——migrations 是只追加历史，构建机不再替你合成 */
  const doBase = {
    ...base,
    migrations: [
      { tag: 'v1', new_sqlite_classes: ['Own'] },
      { tag: 'v2', new_sqlite_classes: ['P_foo_Game', 'P_x_Y'] },
    ],
  }

  it('指向投影输出、关闭打包、追加插件 DO 绑定', () => {
    const projection = makeProjection({
      hash: '0123456789abcdef'.repeat(4),
      metadata: {
        ...makeProjection().metadata,
        exports: { P_foo_Game: { type: 'durable-object', storage: 'sqlite' } },
      },
    })
    const out = generateWranglerConfig({ base: doBase, projection, mainPath: '.projected/index.js' })
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
    // 原样保留模板里的迁移，不再追加 `p-<hash 前 8>` 那一项
    expect(out.migrations).toEqual(doBase.migrations)
  })

  it('插件 DO 类没出现在 migrations 里就报错，并给出该追加的条目', () => {
    const projection = makeProjection({
      metadata: {
        ...makeProjection().metadata,
        exports: { P_foo_Game: { type: 'durable-object', storage: 'sqlite' } },
      },
    })
    expect(() => generateWranglerConfig({ base, projection, mainPath: 'o/index.js' })).toThrow(/P_foo_Game/)
    expect(() => generateWranglerConfig({ base, projection, mainPath: 'o/index.js' })).toThrow(
      /new_sqlite_classes": \["P_foo_Game"\]/,
    )
  })

  describe('migrations 按历史重放', () => {
    const withDo = (...names: string[]) =>
      makeProjection({
        metadata: {
          ...makeProjection().metadata,
          exports: Object.fromEntries(names.map((n) => [n, { type: 'durable-object' as const, storage: 'sqlite' as const }])),
        },
      })

    it('改名进来的（renamed_classes 的 to）与从别的脚本挪进来的（transferred_classes 的 to）都算已有', () => {
      const migrationsBase = {
        name: 'bot',
        migrations: [
          { tag: 'v1', new_sqlite_classes: ['P_foo_Old'] },
          { tag: 'v2', renamed_classes: [{ from: 'P_foo_Old', to: 'P_foo_Game' }] },
          { tag: 'v3', transferred_classes: [{ from: 'Room', from_script: 'other-bot', to: 'P_bar_Room' }] },
        ],
      }
      const warnings: string[] = []
      expect(() =>
        generateWranglerConfig({ base: migrationsBase, projection: withDo('P_foo_Game', 'P_bar_Room'), mainPath: 'o/index.js', warnings }),
      ).not.toThrow()
      expect(warnings).toEqual([])
    })

    it('改名前的旧名、删掉的类从已有里减掉', () => {
      const renamed = {
        name: 'bot',
        migrations: [
          { tag: 'v1', new_sqlite_classes: ['P_foo_Old'] },
          { tag: 'v2', renamed_classes: [{ from: 'P_foo_Old', to: 'P_foo_New' }] },
        ],
      }
      expect(() => generateWranglerConfig({ base: renamed, projection: withDo('P_foo_Old'), mainPath: 'o/index.js' })).toThrow(/P_foo_Old/)

      const deleted = {
        name: 'bot',
        migrations: [
          { tag: 'v1', new_sqlite_classes: ['P_foo_Game'] },
          { tag: 'v2', deleted_classes: ['P_foo_Game'] },
        ],
      }
      expect(() => generateWranglerConfig({ base: deleted, projection: withDo('P_foo_Game'), mainPath: 'o/index.js' })).toThrow(
        /没有出现在 migrations 里：P_foo_Game/,
      )
    })

    it('删掉之后又新建回来（按顺序处理）算已有', () => {
      const base = {
        name: 'bot',
        migrations: [
          { tag: 'v1', new_sqlite_classes: ['P_foo_Game'] },
          { tag: 'v2', deleted_classes: ['P_foo_Game'] },
          { tag: 'v3', new_sqlite_classes: ['P_foo_Game'] },
        ],
      }
      expect(() => generateWranglerConfig({ base, projection: withDo('P_foo_Game'), mainPath: 'o/index.js' })).not.toThrow()
    })

    it('类建在 new_classes（KV 后端）而版本元数据按 sqlite 声明：只警告，不失败；改名沿用旧类的后端', () => {
      const base = {
        name: 'bot',
        migrations: [
          { tag: 'v1', new_classes: ['P_foo_Old'] },
          { tag: 'v2', renamed_classes: [{ from: 'P_foo_Old', to: 'P_foo_Game' }] },
          { tag: 'v3', new_sqlite_classes: ['P_bar_Room'] },
        ],
      }
      const warnings: string[] = []
      generateWranglerConfig({ base, projection: withDo('P_foo_Game', 'P_bar_Room'), mainPath: 'o/index.js', warnings })
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('P_foo_Game')
      expect(warnings[0]).not.toContain('P_bar_Room')
      expect(warnings[0]).toContain('new_sqlite_classes')
    })
  })

  it('模板用 exports 声明 DO 生命周期时不校验 migrations（Cloudflare 规定两者互斥）', () => {
    const projection = makeProjection({
      metadata: {
        ...makeProjection().metadata,
        exports: { P_foo_Game: { type: 'durable-object', storage: 'sqlite' } },
      },
    })
    const exportsBase = { name: 'bot', exports: { P_foo_Game: { type: 'durable-object' } } }
    const out = generateWranglerConfig({ base: exportsBase, projection, mainPath: 'o/index.js' })
    expect(out).not.toHaveProperty('migrations')
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
    const once = generateWranglerConfig({ base: doBase, projection, mainPath: 'o/index.js' })
    const twice = generateWranglerConfig({ base: once, projection, mainPath: 'o/index.js' })
    expect(twice.durable_objects).toEqual(once.durable_objects)
    expect(twice.migrations).toEqual(once.migrations)
  })

  it('自动注入推导得到的资源 ID；不注入 routes，哪怕环境里有 CF_CUSTOM_DOMAIN', () => {
    // 声明了 routes 的配置会让 wrangler 整体替换域名，把用户在后台绑的摘掉
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
      expect(out).not.toHaveProperty('routes')
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

  // 回归：CF_KV_ID=none 以前算「显式跳过」，生成不带 id 的 KV 绑定，降级到 wrangler deploy 时
  // 它会自动预配一个全新的 KV，快照与插件配置当场失联
  it('CF_KV_ID=none 不剥离 KV，也不当成跳过：解析状态是 unresolved，交给部署护栏拒绝', () => {
    const templateBase = { name: 'qqbot', kv_namespaces: [{ binding: 'KV' }] }
    process.env.CF_KV_ID = 'none'
    try {
      const { bindings } = deriveBindings(templateBase)
      expect(resolveState(bindings).kv).toBe('unresolved')
      const out = generateWranglerConfig({ base: templateBase, projection: makeProjection(), mainPath: 'out/index.js', bindings })
      expect(out.kv_namespaces).toEqual([{ binding: 'KV' }])
    } finally {
      delete process.env.CF_KV_ID
    }
  })

  it('CF_KV_ID=none 而模板写着 id：照用模板的，none 不把它顶掉', () => {
    const templateBase = { name: 'qqbot', kv_namespaces: [{ binding: 'KV', id: 'kv-tmpl' }] }
    process.env.CF_KV_ID = 'none'
    try {
      const { bindings } = deriveBindings(templateBase)
      expect(resolveState(bindings).kv).toBe('resolved')
      const out = generateWranglerConfig({ base: templateBase, projection: makeProjection(), mainPath: 'out/index.js', bindings })
      expect(out.kv_namespaces).toEqual([{ binding: 'KV', id: 'kv-tmpl' }])
    } finally {
      delete process.env.CF_KV_ID
    }
  })

  // 回归：以前 D1/R2 分支里有的读法 trim、有的不 trim，` none ` 在推导里算跳过、在剥离判断里不算
  it('哨兵两边带空白也一样算跳过，剥离判断与解析状态一致', () => {
    const templateBase = {
      name: 'qqbot',
      kv_namespaces: [{ binding: 'KV', id: 'kv1' }],
      d1_databases: [{ binding: 'DB', database_id: 'd1-tmpl' }],
      r2_buckets: [{ binding: 'R2', bucket_name: 'b-tmpl' }],
    }
    process.env.CF_D1_ID = ' none '
    process.env.CF_R2_NAME = 'none\n'
    try {
      // 不传 bindings：按 base 与环境变量现推，与 CLI 同一套规则
      const out = generateWranglerConfig({ base: templateBase, projection: makeProjection(), mainPath: 'out/index.js' })
      expect(out.d1_databases).toBeUndefined()
      expect(out.r2_buckets).toBeUndefined()
      expect(out.kv_namespaces).toEqual([{ binding: 'KV', id: 'kv1' }])
    } finally {
      delete process.env.CF_D1_ID
      delete process.env.CF_R2_NAME
    }
  })

  it('不传 bindings 时照样从环境变量补 id（去掉首尾空白）', () => {
    const templateBase = {
      name: 'qqbot',
      kv_namespaces: [{ binding: 'KV' }],
      d1_databases: [{ binding: 'DB', database_name: 'qqbot' }],
      r2_buckets: [{ binding: 'R2' }],
    }
    process.env.CF_KV_ID = ' kv-env '
    process.env.CF_D1_ID = 'd1-env'
    process.env.CF_R2_NAME = 'r2-env'
    try {
      const out = generateWranglerConfig({ base: templateBase, projection: makeProjection(), mainPath: 'out/index.js' })
      expect(out.kv_namespaces).toEqual([{ binding: 'KV', id: 'kv-env' }])
      expect(out.d1_databases).toEqual([{ binding: 'DB', database_name: 'qqbot', database_id: 'd1-env' }])
      expect(out.r2_buckets).toEqual([{ binding: 'R2', bucket_name: 'r2-env' }])
    } finally {
      delete process.env.CF_KV_ID
      delete process.env.CF_D1_ID
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

describe('resolveState', () => {
  const base: BaseBindings = {
    kv: { binding: 'KV', namespaceId: 'kv-1' },
    d1: { binding: 'DB', databaseId: 'd1-1' },
    r2: { binding: 'R2', bucketName: 'bucket' },
  }
  afterEach(() => {
    delete process.env.CF_KV_ID
    delete process.env.CF_D1_ID
    delete process.env.CF_R2_NAME
  })

  it('解析好的资源是 resolved', () => {
    expect(resolveState(base)).toEqual({ kv: 'resolved', d1: 'resolved', r2: 'resolved' })
  })

  it('占位符是 unresolved——D1/R2 在上传元数据里是"不出现"，只能靠这份状态发现', () => {
    const state = resolveState({
      kv: { binding: 'KV', namespaceId: PROVISIONED_PLACEHOLDER },
      d1: { binding: 'DB', databaseId: PROVISIONED_PLACEHOLDER },
      r2: { binding: 'R2', bucketName: PROVISIONED_PLACEHOLDER },
    })
    expect(state).toEqual({ kv: 'unresolved', d1: 'unresolved', r2: 'unresolved' })
  })

  it('CF_*=none 是 skipped，不该被当成"没解析出来"拦下部署', () => {
    process.env.CF_D1_ID = 'none'
    process.env.CF_R2_NAME = 'none'
    const state = resolveState({
      kv: { binding: 'KV', namespaceId: 'kv-1' },
      d1: { binding: 'DB', databaseId: PROVISIONED_PLACEHOLDER },
    })
    expect(state).toEqual({ kv: 'resolved', d1: 'skipped', r2: 'skipped' })
  })

  it('KV 永远不是 skipped：CF_KV_ID=none 时没有 id 就是 unresolved', () => {
    process.env.CF_KV_ID = 'none'
    expect(resolveState({ ...base, kv: { binding: 'KV', namespaceId: PROVISIONED_PLACEHOLDER } }).kv).toBe('unresolved')
    expect(resolveState(base).kv).toBe('resolved')
  })
})

describe('CF_WORKERS_DEV', () => {
  afterEach(() => delete process.env.CF_WORKERS_DEV)

  it('未设置时保持模板原值', () => {
    const config = generateWranglerConfig({
      base: { name: 'w', workers_dev: true },
      projection: makeProjection(),
      mainPath: 'dist/index.js',
    })
    expect(config.workers_dev).toBe(true)
  })

  it('设为 0 可以关掉——绑了自定义域名之后没理由继续把面板暴露在 workers.dev', () => {
    process.env.CF_WORKERS_DEV = '0'
    const config = generateWranglerConfig({
      base: { name: 'w', workers_dev: true },
      projection: makeProjection(),
      mainPath: 'dist/index.js',
    })
    expect(config.workers_dev).toBe(false)
  })
})
