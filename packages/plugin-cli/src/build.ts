import { stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
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
  const alias = options.alias ? { alias: options.alias } : {}

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
    ...alias,
  })

  const bare = findBareImports(result.metafile)
  if (bare.length > 0) {
    throw new Error(`plugin.js 含未打包的外部依赖：${bare.join(', ')}；插件制品必须自包含，请检查依赖是否已安装`)
  }

  await writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const { size } = await stat(outFile)
  return { manifest, outFile, size }
}
