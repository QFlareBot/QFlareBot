import { existsSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import type { Manifest } from '@qqbot/sdk'
import { extractPluginManifest, type ExtractManifestOptions } from './manifest.js'

export interface BuildPluginOptions extends ExtractManifestOptions {
  /** 输出目录，相对 cwd，默认 dist */
  out?: string
  minify?: boolean
}

export interface BuildPluginResult {
  manifest: Manifest
  /** plugin.js 的绝对路径 */
  outFile: string
  /** plugin.js 字节数 */
  size: number
  /** 打进 plugin.js 的第三方包（来自 node_modules，框架自己的包不算），给作者与构建日志核对用 */
  thirdPartyPackages: string[]
}

/**
 * 打进产物的第三方包：看 esbuild metafile 的输入里有没有来自 node_modules 的文件。
 * 取最后一段 node_modules/ 之后的包名，pnpm 的 .pnpm/<pkg>@<ver>/node_modules/<pkg>/ 布局也认得出。
 * 比看 import 语句可靠：只写类型、被 esbuild 摇掉的 import 不会进 inputs，不会误报。
 * 框架自己的包（@qqbot/*）不列：SDK 是契约本身，其余在解析阶段就被 frameworkGuard 挡下了。
 */
export function bundledPackages(metafile: esbuild.Metafile): string[] {
  const found = new Set<string>()
  for (const input of Object.keys(metafile.inputs)) {
    const normalized = input.split('\\').join('/')
    const at = normalized.lastIndexOf('node_modules/')
    if (at < 0) continue
    const [first = '', second = ''] = normalized.slice(at + 'node_modules/'.length).split('/')
    const name = first.startsWith('@') ? `${first}/${second}` : first
    if (name && !name.startsWith('@qqbot/')) found.add(name)
  }
  return [...found].sort()
}

/**
 * 框架内部的包不许打进插件：插件的能力都从 ctx / session 上取（运行时注入），import 了 @qqbot/runtime
 * 之类会把第二份运行时打进来，状态与主运行时各管各的。@qqbot/sdk（及子路径）是契约本身，照常放行。
 *
 * 在解析阶段按 import 路径拦，而不是看打包后的文件路径：工作区里的包是软链接，
 * 解析出来的真实路径里没有 node_modules，按路径看会漏掉。
 */
const frameworkGuard: esbuild.Plugin = {
  name: 'qqbot-framework-guard',
  setup(build) {
    build.onResolve({ filter: /^@qqbot\// }, (args) => {
      if (args.path === '@qqbot/sdk' || args.path.startsWith('@qqbot/sdk/')) return undefined
      return {
        errors: [{ text: `插件不能 import 框架内部的包 ${args.path}：能力都从 ctx / session 上取，只有 @qqbot/sdk 可以打包进插件` }],
      }
    })
  },
}

/** SDK 在产物里的虚拟命名空间：产物注释写成 `// qqbot-sdk:src/plugin.ts`，见 sdkNamespace */
const SDK_NAMESPACE = 'qqbot-sdk'

/** SDK 包根目录：从入口往上找最近的 package.json；找不到就用入口所在目录 */
function packageRootOf(file: string): string {
  let dir = path.dirname(file)
  for (;;) {
    if (existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return path.dirname(file)
    dir = parent
  }
}

const LOADERS: Record<string, esbuild.Loader> = {
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'jsx',
  '.json': 'json',
}

/**
 * 把 alias 指过去的 SDK 解析进固定的虚拟命名空间，让产物与构建机无关。
 *
 * SDK 一律用机器人仓库（或 plugin-cli 自带）的那一份，经 alias 指向一个绝对路径。esbuild 会把每个输入文件
 * 相对 absWorkingDir 的路径写进产物注释：git 插件解包在构建机的临时目录里，SDK 却在机器人仓库里，
 * 注释就成了 `// ../../../../opt/buildhome/repo/packages/sdk/src/plugin.ts`——同一组插件换一台机器、
 * 换个仓库位置，plugin.js 的 integrity 就不同，投影哈希跟着变。放进虚拟命名空间后路径只相对 SDK 自己的
 * 包根目录，产物只取决于 SDK 的内容与目录结构。
 *
 * 只接管 `@qqbot/sdk` 本身，子路径仍按 alias 走（与以前一样）；SDK 内部的相对 import 用 esbuild 自己的
 * 解析规则（`./x.js` 找到 `x.ts` 之类）解析出真实文件，还在 SDK 目录里的继续留在命名空间内，
 * 外部的（`cloudflare:*`）原样交还。
 */
function sdkNamespace(sdkEntry: string): esbuild.Plugin {
  const root = packageRootOf(sdkEntry)
  const toVirtual = (result: esbuild.ResolveResult): esbuild.OnResolveResult => {
    if (result.errors.length > 0) return { errors: result.errors, warnings: result.warnings }
    if (result.external || result.namespace !== 'file') return result
    const rel = path.relative(root, result.path)
    if (rel.startsWith('..') || path.isAbsolute(rel)) return result
    return { path: rel.split(path.sep).join('/'), namespace: SDK_NAMESPACE, sideEffects: result.sideEffects }
  }
  return {
    name: 'qqbot-sdk-namespace',
    setup(build) {
      build.onResolve({ filter: /^@qqbot\/sdk$/ }, async (args) =>
        toVirtual(await build.resolve(sdkEntry, { kind: args.kind, resolveDir: args.resolveDir })),
      )
      build.onResolve({ filter: /.*/, namespace: SDK_NAMESPACE }, async (args) =>
        toVirtual(
          await build.resolve(args.path, { kind: args.kind, resolveDir: args.resolveDir, importer: path.join(root, args.importer) }),
        ),
      )
      build.onLoad({ filter: /.*/, namespace: SDK_NAMESPACE }, async (args) => {
        const file = path.join(root, args.path)
        return { contents: await readFile(file, 'utf8'), loader: LOADERS[path.extname(file)] ?? 'js', resolveDir: path.dirname(file) }
      })
    },
  }
}

function resolveDefaultAlias(custom?: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = { ...custom }
  if (!merged['@qqbot/sdk']) {
    try {
      merged['@qqbot/sdk'] = fileURLToPath(import.meta.resolve('@qqbot/sdk'))
    } catch {}
  }
  return merged
}

/** 制品必须自包含：除 `cloudflare:*` 外不允许留下任何未打包的 import */
function findBareImports(metafile: esbuild.Metafile): string[] {
  const main = Object.values(metafile.outputs).find((o) => o.entryPoint !== undefined)
  if (!main) return []
  return [...new Set(main.imports.filter((i) => i.external && !i.path.startsWith('cloudflare:')).map((i) => i.path))]
}

/** 打包为 `<out>/plugin.js`（附 .map）并写出 `<out>/manifest.json` */
export async function buildPlugin(options: BuildPluginOptions = {}): Promise<BuildPluginResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd())
  const entry = path.resolve(cwd, options.entry ?? 'src/index.ts')
  const outDir = path.resolve(cwd, options.out ?? 'dist')
  const outFile = path.join(outDir, 'plugin.js')
  const resolvedAlias = resolveDefaultAlias(options.alias)
  const alias = Object.keys(resolvedAlias).length > 0 ? { alias: resolvedAlias } : {}
  // alias 指到的 SDK 走虚拟命名空间（见 sdkNamespace）；没指（解析不到 SDK）就照常从插件自己的 node_modules 解析，
  // 那时路径本来就在插件目录里、与机器无关
  const sdkEntry = resolvedAlias['@qqbot/sdk']

  // 先抽清单：定义或校验有问题时不留下半成品
  const manifest = await extractPluginManifest({ entry, cwd, ...alias })

  const result = await esbuild.build({
    entryPoints: [entry],
    outfile: outFile,
    absWorkingDir: cwd,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'browser',
    conditions: ['workerd', 'worker', 'browser'],
    external: ['cloudflare:*'],
    sourcemap: 'external',
    legalComments: 'none',
    minify: options.minify ?? false,
    metafile: true,
    logLevel: 'warning',
    plugins: sdkEntry ? [frameworkGuard, sdkNamespace(sdkEntry)] : [frameworkGuard],
    ...alias,
  })

  const bare = findBareImports(result.metafile)
  if (bare.length > 0) {
    throw new Error(`plugin.js 含未打包的外部依赖：${bare.join(', ')}；插件制品必须自包含，请检查依赖是否已安装`)
  }

  await writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const { size } = await stat(outFile)
  return { manifest, outFile, size, thirdPartyPackages: bundledPackages(result.metafile) }
}
