#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { createHttpFetcher, parseSource } from './artifacts.js'
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

/** 本地清单里插件的 `manifest` 允许写成 `file:` 指向构建产物 manifest.json，避免手抄 */
async function loadLocalManifest(manifestPath: string): Promise<DeployManifest> {
  const raw = JSON.parse(await readFile(manifestPath, 'utf8')) as DeployManifest
  const dir = path.dirname(manifestPath)
  const plugins = await Promise.all(
    raw.plugins.map(async (p) => {
      const ref = p.manifest as unknown
      if (typeof ref !== 'string') return p
      const { scheme, value } = parseSource(ref)
      if (scheme !== 'file') throw new Error(`插件 ${p.name} 的 manifest 只支持内联对象或 file: 引用`)
      return { ...p, manifest: JSON.parse(await readFile(path.resolve(dir, value), 'utf8')) as DeployManifest['plugins'][number]['manifest'] }
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
