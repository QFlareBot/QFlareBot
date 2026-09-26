#!/usr/bin/env node
import path from 'node:path'
import { parseArgs } from 'node:util'
import type { Manifest } from '@qqbot/sdk'
import { buildPlugin } from './build.js'
import { extractPluginManifest, ManifestValidationError } from './manifest.js'
import { panelWarnings } from './panel.js'

const USAGE = `用法：qqbot-plugin <命令> [选项]

命令：
  build      打包为 <out>/plugin.js 并生成 <out>/manifest.json
  validate   只在 Node 中加载入口、抽取并校验清单，不产出文件

选项：
  --entry <文件>   入口文件，相对 cwd，默认 src/index.ts
  --out <目录>     输出目录，相对 cwd，默认 dist（仅 build）
  --cwd <目录>     插件根目录（含 package.json），默认当前目录
  --minify         压缩 plugin.js（仅 build）
  -h, --help       显示帮助`

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}

function printSummary(manifest: Manifest, size?: number, packages: string[] = []): void {
  const rows: Array<[string, string | number]> = [
    ['名称', manifest.name],
    ['版本', manifest.version],
    ['命令', manifest.commands.length],
    ['事件', manifest.events.length],
    ['DO 类', manifest.durableObjects.length],
  ]
  if (size !== undefined) rows.push(['plugin.js', formatSize(size)])
  // 打进产物的第三方包：机器人的构建机会按 lockfile 装同样的版本，记得把 lockfile 一起提交
  if (packages.length > 0) rows.push(['第三方包', packages.join('、')])
  for (const [label, value] of rows) console.log(`  ${label}：${value}`)
  // 不拦构建：放不进面板只是少一个点选入口，命令照样能打字触发
  for (const warning of panelWarnings(manifest)) console.warn(`  ⚠ ${warning}`)
}

/** esbuild 的 BuildFailure，详细错误已由 esbuild 自己打印 */
function isEsbuildFailure(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { errors?: unknown; warnings?: unknown }
  return Array.isArray(e.errors) && Array.isArray(e.warnings)
}

/** parseArgs 抛出的参数错误（未知选项、缺少值等） */
function isParseArgsError(err: unknown): err is Error {
  return err instanceof TypeError && String((err as { code?: unknown }).code).startsWith('ERR_PARSE_ARGS')
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      entry: { type: 'string' },
      out: { type: 'string' },
      cwd: { type: 'string' },
      minify: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const command = positionals[0]
  if (values.help) {
    console.log(USAGE)
    return 0
  }
  if (command === undefined) {
    console.error(USAGE)
    return 1
  }

  const common = {
    ...(values.entry !== undefined ? { entry: values.entry } : {}),
    ...(values.cwd !== undefined ? { cwd: values.cwd } : {}),
  }

  switch (command) {
    case 'build': {
      const { manifest, outFile, size, thirdPartyPackages } = await buildPlugin({
        ...common,
        ...(values.out !== undefined ? { out: values.out } : {}),
        minify: values.minify ?? false,
      })
      const rel = path.relative(process.cwd(), outFile)
      console.log(`已构建 ${rel.startsWith('..') ? outFile : rel}`)
      printSummary(manifest, size, thirdPartyPackages)
      return 0
    }
    case 'validate': {
      const manifest = await extractPluginManifest(common)
      console.log('清单校验通过')
      printSummary(manifest)
      return 0
    }
    default:
      console.error(`未知命令：${command}\n\n${USAGE}`)
      return 1
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (err: unknown) => {
    if (isParseArgsError(err)) console.error(`${err.message}\n\n${USAGE}`)
    else if (err instanceof ManifestValidationError) console.error(err.message)
    else if (isEsbuildFailure(err)) console.error('构建失败')
    else console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  },
)
