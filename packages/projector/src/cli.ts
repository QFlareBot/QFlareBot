#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { createHttpFetcher, fetchPluginManifest, parseSource } from './artifacts.js'
import { parseJsonc } from './jsonc.js'
import { project } from './project.js'
import type { DeployManifest, FetchArtifact } from './types.js'
import { type WranglerConfig, deriveBindings, generateWranglerConfig } from './wrangler.js'

const USAGE = `用法：
  qqbot-project build --manifest <manifest.json> --wrangler <wrangler.jsonc> --out <dir>

选项：
  --manifest   部署清单（DeployManifest JSON），source 支持 file:（相对清单文件）与 npm:/github:/url:
  --wrangler   基础 wrangler.jsonc；bindings 从 kv_namespaces[0]/d1_databases[0]/r2_buckets[0]/vars 推导
  --out        投影输出目录（写入 index.js、runtime.js、plugins/*.js、projection.json）
`

/** file: 读磁盘（相对清单所在目录），其余走 HTTP */
function createLocalFetcher(manifestDir: string): FetchArtifact {
  const http = createHttpFetcher()
  return async (ref) => {
    const { scheme, value } = parseSource(ref.source)
    if (scheme !== 'file') return http(ref)
    return readFile(path.resolve(manifestDir, value), 'utf8')
  }
}

type PluginManifest = DeployManifest['plugins'][number]['manifest']

/**
 * 补齐每个插件的 `manifest`，三种来源：
 *   1. 清单里内联的对象，原样用；
 *   2. 写成 `file:` 的字符串引用，从磁盘读（免得手抄构建产物）；
 *   3. 没写：按 source 推导——`file:` 取同目录的 manifest.json，远程源按 URL 规则去拉。
 */
async function loadLocalManifest(manifestPath: string): Promise<DeployManifest> {
  const raw = JSON.parse(await readFile(manifestPath, 'utf8')) as DeployManifest
  const dir = path.dirname(manifestPath)
  const readJson = async (p: string): Promise<PluginManifest> => JSON.parse(await readFile(p, 'utf8')) as PluginManifest

  const plugins = await Promise.all(
    raw.plugins.map(async (p) => {
      const ref = p.manifest as unknown
      if (ref && typeof ref === 'object') return p
      if (typeof ref === 'string') {
        const { scheme, value } = parseSource(ref)
        if (scheme !== 'file') throw new Error(`插件 ${p.name} 的 manifest 写成字符串时只支持 file: 引用；远程源直接省略这个字段即可`)
        return { ...p, manifest: await readJson(path.resolve(dir, value)) }
      }

      const { scheme, value } = parseSource(p.source)
      if (scheme === 'file') return { ...p, manifest: await readJson(path.resolve(dir, path.dirname(value), 'manifest.json')) }
      return { ...p, manifest: await fetchPluginManifest({ kind: 'plugin', name: p.name, version: p.version, source: p.source }) }
    }),
  )
  return { ...raw, plugins }
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/')
}

async function build(args: { manifest: string; wrangler: string; out: string }): Promise<void> {
  const manifestPath = path.resolve(args.manifest)
  const wranglerPath = path.resolve(args.wrangler)
  const outDir = path.resolve(args.out)

  const manifest = await loadLocalManifest(manifestPath)
  const wranglerConfig = parseJsonc<WranglerConfig>(await readFile(wranglerPath, 'utf8'))
  const { bindings, warnings } = deriveBindings(wranglerConfig)

  const compatibilityDate = wranglerConfig.compatibility_date ?? new Date().toISOString().slice(0, 10)
  if (!wranglerConfig.compatibility_date) warnings.push(`wrangler 配置缺少 compatibility_date，使用今天：${compatibilityDate}`)

  const projection = await project({
    manifest,
    fetchArtifact: createLocalFetcher(path.dirname(manifestPath)),
    bindings,
    compatibilityDate,
    ...(wranglerConfig.compatibility_flags ? { compatibilityFlags: wranglerConfig.compatibility_flags } : {}),
  })

  for (const [name, code] of Object.entries(projection.modules)) {
    const file = path.join(outDir, name)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, code, 'utf8')
  }
  await writeFile(
    path.join(outDir, 'projection.json'),
    JSON.stringify({ hash: projection.hash, integrity: projection.integrity, metadata: projection.metadata }, null, 2),
    'utf8',
  )

  const wranglerDir = path.dirname(wranglerPath)
  const generated = generateWranglerConfig({
    base: wranglerConfig,
    projection,
    mainPath: toPosix(path.relative(wranglerDir, path.join(outDir, 'index.js'))),
    bindings,
  })
  const generatedPath = path.join(wranglerDir, 'wrangler.generated.jsonc')
  await writeFile(generatedPath, `// 由 @qqbot/projector 生成，勿手改\n${JSON.stringify(generated, null, 2)}\n`, 'utf8')

  const doCount = Object.keys(projection.metadata.exports ?? {}).length
  console.log(`投影完成
  core        ${manifest.core.version}
  插件        ${manifest.plugins.length} 个${doCount ? `（Durable Object 类 ${doCount} 个）` : ''}
  hash        ${projection.hash}
  输出        ${outDir}
  wrangler    ${generatedPath}`)
  for (const w of warnings) console.log(`  提醒        ${w}`)
}

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      manifest: { type: 'string' },
      wrangler: { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const command = positionals[0]
  if (values.help || !command) {
    console.log(USAGE)
    process.exitCode = command ? 0 : 1
    return
  }
  if (command !== 'build') throw new Error(`未知命令：${command}\n${USAGE}`)
  const missing = (['manifest', 'wrangler', 'out'] as const).filter((k) => !values[k])
  if (missing.length) throw new Error(`缺少参数：${missing.map((m) => `--${m}`).join(' ')}\n${USAGE}`)
  await build({ manifest: values.manifest as string, wrangler: values.wrangler as string, out: values.out as string })
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
