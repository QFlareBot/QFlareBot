import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildPlugin, bundledPackages } from './build.js'
import { expectedPluginName, extractPluginManifest, ManifestValidationError } from './manifest.js'

// 临时插件里的 `@qqbot/sdk` 直接指向 SDK 源码，不依赖 dist 或 node_modules
const alias = { '@qqbot/sdk': fileURLToPath(new URL('../../sdk/src/index.ts', import.meta.url)) }

const PLUGIN_SOURCE = `
import { definePlugin, PluginDurableObject } from '@qqbot/sdk'

// 必须继承 PluginDurableObject 而不是平台的 DurableObject：前者会把平台给的裸 env
// 换成本插件的作用域上下文（this.plugin），不继承的话构建期就会被 assertDurableObjectsScoped 挡下
export class Counter extends PluginDurableObject {
  async increment() { return 1 }
}

export default definePlugin<{ greeting: string }>({
  name: 'demo',
  description: '测试插件',
  defaultConfig: { greeting: '你好' },
  commands: {
    hello: {
      description: '打招呼',
      aliases: ['hi'],
      async handler({ session, ctx, argText }) {
        await session.reply(\`\${ctx.config.greeting} \${argText}\`.trim())
      },
    },
    // 处理器内部按需 import 的 cloudflare:* 模块：抽清单时不会执行，打包时保留为外部依赖
    sock: {
      async handler() {
        const { connect } = await import('cloudflare:sockets')
        connect('example.com:80')
      },
    },
  },
  events: [{ event: 'qq.group.robot_added', handler: async () => {} }],
  durableObjects: { Counter },
})
`

/** 提取 ESM 顶层 import/export ... from 的模块说明符 */
function importSpecifiers(code: string): string[] {
  const re = /^(?:import|export)\b[^\n]*?\bfrom\s*["']([^"']+)["']|^import\s*["']([^"']+)["']/gm
  return [...code.matchAll(re)].map((m) => m[1] ?? m[2] ?? '')
}

let dir: string

async function writePlugin(source: string, pkg: Record<string, unknown> = {}): Promise<void> {
  const packageJson = { name: 'qflarebot-plugin-demo', version: '1.2.3', type: 'module', ...pkg }
  await writeFile(path.join(dir, 'package.json'), JSON.stringify(packageJson))
  await mkdir(path.join(dir, 'src'), { recursive: true })
  await writeFile(path.join(dir, 'src/index.ts'), source)
}

const exists = (p: string) => access(p).then(() => true, () => false)

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'qqbot-plugin-cli-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('buildPlugin', () => {
  it('产出自包含的 plugin.js 与 manifest.json', async () => {
    await writePlugin(PLUGIN_SOURCE)
    const result = await buildPlugin({ cwd: dir, alias })

    expect(result.outFile).toBe(path.join(dir, 'dist', 'plugin.js'))
    const code = await readFile(result.outFile, 'utf8')
    expect(result.size).toBe(Buffer.byteLength(code))
    expect(await exists(`${result.outFile}.map`)).toBe(true)

    // SDK 被打进 bundle，只剩 cloudflare:* 留作外部依赖
    expect(importSpecifiers(code)).toEqual(['cloudflare:workers'])
    expect(code).toContain('import("cloudflare:sockets")')
    expect(code).toContain('function definePlugin')

    const raw = await readFile(path.join(dir, 'dist', 'manifest.json'), 'utf8')
    expect(raw.startsWith('{\n  "name"')).toBe(true)
    const manifest = JSON.parse(raw)
    expect(manifest).toEqual(result.manifest)
    expect(manifest).toMatchObject({
      name: 'demo',
      version: '1.2.3',
      apiVersion: 1,
      description: '测试插件',
      defaultConfig: { greeting: '你好' },
      commands: [{ name: 'hello', description: '打招呼', aliases: ['hi'] }, { name: 'sock' }],
      events: [{ event: ['qq.group.robot_added'] }],
      durableObjects: ['Counter'],
    })
    expect(raw).not.toContain('handler')
  })

  it('支持 minify 与自定义 entry/out', async () => {
    await mkdir(path.join(dir, 'lib'), { recursive: true })
    await writePlugin('')
    await writeFile(path.join(dir, 'lib', 'main.ts'), PLUGIN_SOURCE)

    const result = await buildPlugin({ cwd: dir, entry: 'lib/main.ts', out: 'build', minify: true, alias })
    expect(result.outFile).toBe(path.join(dir, 'build', 'plugin.js'))
    expect(await exists(path.join(dir, 'build', 'manifest.json'))).toBe(true)
    expect(result.manifest.name).toBe('demo')
  })

  it('入口未默认导出 definePlugin 时报错且不产出文件', async () => {
    await writePlugin(`export const plugin = { name: 'demo' }`)
    await expect(buildPlugin({ cwd: dir, alias })).rejects.toThrow('入口必须默认导出 definePlugin')
    expect(await exists(path.join(dir, 'dist'))).toBe(false)
  })
})

describe('第三方依赖', () => {
  /** 在临时插件目录里放一个假的 npm 包 */
  async function fakePackage(name: string, code = 'export const pad = (s) => ` ${s}`\n'): Promise<void> {
    const pkgDir = path.join(dir, 'node_modules', ...name.split('/'))
    await mkdir(pkgDir, { recursive: true })
    await writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', main: 'index.js' }))
    await writeFile(path.join(pkgDir, 'index.js'), code)
  }

  it('第三方包照常打进 plugin.js，并把包名报出来', async () => {
    await writePlugin(`
import { definePlugin } from '@qqbot/sdk'
import { pad } from 'left-pad'
export default definePlugin({ name: 'demo', commands: { p: () => pad('x') } })
`)
    await fakePackage('left-pad')
    const result = await buildPlugin({ cwd: dir, alias })
    expect(result.thirdPartyPackages).toEqual(['left-pad'])
    // 打进去了，不是留成外部 import（这个插件没用 DO，连 cloudflare:workers 都摇掉了）
    const code = await readFile(result.outFile, 'utf8')
    expect(code).toContain('` ${s}`')
    expect(importSpecifiers(code)).toEqual([])
  })

  it('只 import 类型不算：被 esbuild 摇掉，不进产物', async () => {
    await writePlugin(`
import { definePlugin } from '@qqbot/sdk'
import type { Pad } from 'left-pad'
const nothing: Pad | null = null
export default definePlugin({ name: 'demo', commands: { p: () => String(nothing) } })
`)
    await fakePackage('left-pad')
    expect((await buildPlugin({ cwd: dir, alias })).thirdPartyPackages).toEqual([])
  })

  it('SDK 本身不算第三方', async () => {
    await writePlugin(PLUGIN_SOURCE)
    expect((await buildPlugin({ cwd: dir, alias })).thirdPartyPackages).toEqual([])
  })

  it('框架内部的包不许打进插件：会带进第二份运行时', async () => {
    await writePlugin(`
import { definePlugin } from '@qqbot/sdk'
import { createRuntime } from '@qqbot/runtime'
export default definePlugin({ name: 'demo', commands: { p: () => String(typeof createRuntime) } })
`)
    await fakePackage('@qqbot/runtime', 'export const createRuntime = () => ({})\n')
    await expect(buildPlugin({ cwd: dir, alias })).rejects.toThrow('插件不能 import 框架内部的包 @qqbot/runtime')
  })
})

describe('bundledPackages', () => {
  it('认得出普通、scoped 与 pnpm 布局的包名；框架自己的包不列', () => {
    const inputs = {
      'src/index.ts': {},
      'node_modules/left-pad/index.js': {},
      'node_modules/.pnpm/@scope+x@1.0.0/node_modules/@scope/x/dist/a.js': {},
      '../node_modules/@qqbot/sdk/dist/index.js': {},
    }
    expect(bundledPackages({ inputs, outputs: {} } as never)).toEqual(['@scope/x', 'left-pad'])
  })
})

describe('extractPluginManifest', () => {
  it('version 来自 package.json，缺失时报错', async () => {
    await writePlugin(PLUGIN_SOURCE, { version: undefined })
    await expect(extractPluginManifest({ cwd: dir, alias })).rejects.toThrow('version')
  })

  it('清单校验失败时抛出含全部错误的异常', async () => {
    await writePlugin(`
      import { definePlugin } from '@qqbot/sdk'
      export default definePlugin({
        name: 'Bad Name',
        commands: { a: { aliases: ['b'], handler() {} }, b: { handler() {} } },
        regex: [{ pattern: '(', handler() {} }],
      })
    `)
    const err: unknown = await extractPluginManifest({ cwd: dir, alias }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ManifestValidationError)
    const { errors, message } = err as ManifestValidationError
    // 前三条来自 validateManifest，第四条是 name 与包名不一致
    expect(errors).toHaveLength(4)
    expect(errors.some((e) => e.includes('name 非法'))).toBe(true)
    expect(errors.some((e) => e.includes('命令名重复：b'))).toBe(true)
    expect(errors.some((e) => e.includes('正则非法'))).toBe(true)
    expect(errors.some((e) => e.includes('name 与包名不一致'))).toBe(true)
    expect(message).toContain('name 非法')
    expect(message).toContain('正则非法')
  })

  it('name 与包名不一致时报错', async () => {
    await writePlugin(PLUGIN_SOURCE, { name: 'qflarebot-plugin-other' })
    const err: unknown = await extractPluginManifest({ cwd: dir, alias }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ManifestValidationError)
    expect((err as ManifestValidationError).errors).toEqual([
      expect.stringContaining('期望 name 为 "other"，实际为 "demo"'),
    ])
  })

  it('带 scope 的包名去掉 scope 与前缀后比对', async () => {
    await writePlugin(PLUGIN_SOURCE, { name: '@me/qflarebot-plugin-demo' })
    expect((await extractPluginManifest({ cwd: dir, alias })).name).toBe('demo')
  })

  it('改名前的 qqbot-plugin- 前缀照样认', async () => {
    await writePlugin(PLUGIN_SOURCE, { name: 'qqbot-plugin-demo' })
    expect((await extractPluginManifest({ cwd: dir, alias })).name).toBe('demo')
  })

  it('包名不带约定前缀时要求与 name 完全一致', async () => {
    await writePlugin(PLUGIN_SOURCE, { name: 'demo' })
    expect((await extractPluginManifest({ cwd: dir, alias })).name).toBe('demo')

    await writePlugin(PLUGIN_SOURCE, { name: 'demo-plugin' })
    await expect(extractPluginManifest({ cwd: dir, alias })).rejects.toThrow('name 与包名不一致')
  })
})

describe('expectedPluginName', () => {
  it.each([
    ['qflarebot-plugin-hello', 'hello'],
    ['@me/qflarebot-plugin-hello', 'hello'],
    ['qqbot-plugin-hello', 'hello'],
    ['@me/qqbot-plugin-hello', 'hello'],
    ['@scope/my-plugin', 'my-plugin'],
    ['hello', 'hello'],
    ['qflarebot-plugin-', ''],
    ['qqbot-plugin-', ''],
  ])('%s → %s', (pkgName, expected) => {
    expect(expectedPluginName(pkgName)).toBe(expected)
  })
})

describe('Durable Object 基类强制', () => {
  // 忘了继承的后果是静默的：类照样部署照样跑，但里面的 KV/D1/R2 全是未加前缀的，
  // 建的表框架不认识、卸载时清不掉。跟 D1 表名占位符一样，必须在构建期挡住。
  const BARE_DO_SOURCE = `
import { definePlugin } from '@qqbot/sdk'
import { DurableObject } from 'cloudflare:workers'

export class Counter extends DurableObject {}

export default definePlugin({ name: 'demo', commands: {}, durableObjects: { Counter } })
`

  it('DO 类没继承 PluginDurableObject 时构建失败，并给出改法', async () => {
    await writePlugin(BARE_DO_SOURCE)
    await expect(extractPluginManifest({ cwd: dir, alias })).rejects.toThrow(
      /Durable Object 类必须继承 PluginDurableObject：Counter/,
    )
  })
})
