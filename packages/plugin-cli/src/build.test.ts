import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildPlugin } from './build.js'
import { expectedPluginName, extractPluginManifest, ManifestValidationError } from './manifest.js'

// 临时插件里的 `@qqbot/sdk` 直接指向 SDK 源码，不依赖 dist 或 node_modules
const alias = { '@qqbot/sdk': fileURLToPath(new URL('../../sdk/src/index.ts', import.meta.url)) }

const PLUGIN_SOURCE = `
import { definePlugin } from '@qqbot/sdk'
import { DurableObject } from 'cloudflare:workers'

export class Counter extends DurableObject {
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
  const packageJson = { name: 'qqbot-plugin-demo', version: '1.2.3', type: 'module', ...pkg }
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
    await writePlugin(PLUGIN_SOURCE, { name: 'qqbot-plugin-other' })
    const err: unknown = await extractPluginManifest({ cwd: dir, alias }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ManifestValidationError)
    expect((err as ManifestValidationError).errors).toEqual([
      expect.stringContaining('期望 name 为 "other"，实际为 "demo"'),
    ])
  })

  it('带 scope 的包名去掉 scope 与前缀后比对', async () => {
    await writePlugin(PLUGIN_SOURCE, { name: '@me/qqbot-plugin-demo' })
    expect((await extractPluginManifest({ cwd: dir, alias })).name).toBe('demo')
  })

  it('包名不带 qqbot-plugin- 前缀时要求与 name 完全一致', async () => {
    await writePlugin(PLUGIN_SOURCE, { name: 'demo' })
    expect((await extractPluginManifest({ cwd: dir, alias })).name).toBe('demo')

    await writePlugin(PLUGIN_SOURCE, { name: 'demo-plugin' })
    await expect(extractPluginManifest({ cwd: dir, alias })).rejects.toThrow('name 与包名不一致')
  })
})

describe('expectedPluginName', () => {
  it.each([
    ['qqbot-plugin-hello', 'hello'],
    ['@me/qqbot-plugin-hello', 'hello'],
    ['@scope/my-plugin', 'my-plugin'],
    ['hello', 'hello'],
    ['qqbot-plugin-', ''],
  ])('%s → %s', (pkgName, expected) => {
    expect(expectedPluginName(pkgName)).toBe(expected)
  })
})
