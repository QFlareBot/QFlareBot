import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'
import {
  extractManifest,
  validateManifest,
  type Manifest,
  type PluginDefinition,
} from '@qqbot/sdk'
// 和运行时调度用的是同一份实现；构建工具不依赖运行时，所以它放在 SDK 里
import { cronError } from '@qqbot/sdk/cron'

export interface ExtractManifestOptions {
  /** 入口文件，相对 cwd，默认 src/index.ts */
  entry?: string
  /** 插件根目录（含 package.json），默认 process.cwd() */
  cwd?: string
  /** 内部/测试用：透传给 esbuild 的包名别名 */
  alias?: Record<string, string>
}

/** 清单校验失败；`errors` 为全部错误 */
export class ManifestValidationError extends Error {
  readonly errors: string[]

  constructor(errors: string[]) {
    super(`清单校验失败：\n${errors.map((e) => `  - ${e}`).join('\n')}`)
    this.name = 'ManifestValidationError'
    this.errors = errors
  }
}

// 同目录下的桩文件；vitest 直接跑 src（.ts），构建后跑 dist（.js），扩展名跟随当前文件
const here = fileURLToPath(import.meta.url)
const STUB_PATH = path.join(path.dirname(here), 'stubs', `cloudflare-workers${path.extname(here)}`)

/**
 * Node 下无法加载 `cloudflare:*`：workers 指向桩；其余模块的动态 import 保留为外部依赖
 * （处理器内部才执行，抽清单时不会触发），静态 import 则给出明确错误。
 */
const cloudflareStubPlugin: esbuild.Plugin = {
  name: 'qqbot-cloudflare-stub',
  setup(build) {
    build.onResolve({ filter: /^cloudflare:/ }, (args) => {
      if (args.path === 'cloudflare:workers') return { path: STUB_PATH }
      if (args.kind === 'dynamic-import') return { path: args.path, external: true }
      return {
        errors: [
          {
            text: `抽取清单时无法在 Node 中加载 ${args.path}；请改为在处理器内部按需 import()，不要在模块顶层依赖它`,
          },
        ],
      }
    })
  },
}

async function readPackageJson(cwd: string): Promise<{ name?: string; version?: string }> {
  let raw: string
  try {
    raw = await readFile(path.join(cwd, 'package.json'), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
  const pkg = JSON.parse(raw) as { name?: unknown; version?: unknown }
  return {
    ...(typeof pkg.name === 'string' ? { name: pkg.name } : {}),
    ...(typeof pkg.version === 'string' ? { version: pkg.version } : {}),
  }
}

/** 约定的包名前缀：`qflarebot-plugin-` 是现在的写法，`qqbot-plugin-` 是改名前的，照样认 */
const PLUGIN_PKG_PREFIXES = ['qflarebot-plugin-', 'qqbot-plugin-']

/**
 * 由包名推出插件 name：去掉 `@scope/`，再去掉约定的前缀（见 PLUGIN_PKG_PREFIXES）。
 * `@me/qflarebot-plugin-hello`、`qflarebot-plugin-hello`、`qqbot-plugin-hello` 都得到 `hello`；不带前缀的包名原样返回。
 */
export function expectedPluginName(pkgName: string): string {
  const unscoped = pkgName.startsWith('@') ? pkgName.slice(pkgName.indexOf('/') + 1) : pkgName
  const prefix = PLUGIN_PKG_PREFIXES.find((p) => unscoped.startsWith(p))
  return prefix ? unscoped.slice(prefix.length) : unscoped
}

/**
 * 写错的 cron 表达式：运行时一次都不会触发它。只警告、不拦构建——以前的构建不查这个，
 * 已装的插件同步上游后不能因为多了这道检查就构建失败。段数不对的 validateManifest 早就当错误拦了。
 */
export function cronWarnings(manifest: Pick<Manifest, 'name' | 'cron'>): string[] {
  const out: string[] = []
  for (const job of manifest.cron) {
    const error = cronError(job.cron)
    if (error) out.push(`${manifest.name}：定时任务「${job.name}」的 cron 表达式「${job.cron}」不合法，运行时不会触发：${error}`)
  }
  return out
}

function isPluginDefinition(value: unknown): value is PluginDefinition<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { name?: unknown }).name === 'string'
}

/**
 * 把入口打成 Node 可执行的临时 ESM 文件并 import。
 *
 * 返回**整个模块命名空间**而不只是默认导出：`durableObjects` 的键名必须与入口里
 * 真正导出的类名一致（投影生成的 glue 是 `import { <键名> as … } from '插件模块'`），
 * 这件事只有在拿到命名空间时才能在构建期检查出来。见 `assertDurableObjectExports`。
 */
async function loadModule(
  entry: string,
  cwd: string,
  alias: Record<string, string> | undefined,
): Promise<Record<string, unknown>> {
  const tmpFile = path.join(os.tmpdir(), `qqbot-plugin-${process.pid}-${randomUUID()}.mjs`)
  try {
    await esbuild.build({
      entryPoints: [entry],
      outfile: tmpFile,
      absWorkingDir: cwd,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      legalComments: 'none',
      logLevel: 'warning',
      plugins: [cloudflareStubPlugin],
      ...(alias ? { alias } : {}),
    })

    return (await import(pathToFileURL(tmpFile).href)) as Record<string, unknown>
  } catch (error) {
    // 产物是临时的，报错里带着 /tmp 路径对作者没有意义，换成入口文件
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`加载插件入口失败（${path.relative(cwd, entry) || entry}）：${message}`)
  } finally {
    await rm(tmpFile, { force: true })
  }
}

/**
 * `durableObjects` 的键必须与入口模块里**真的导出**的名字一致。
 *
 * 投影器生成的入口是 `import { Agent as _do_P_agent_Agent } from './plugins/agent.js'`，
 * 它按清单里的键名去取导出。插件若写 `durableObjects: { Agent: AgentObject }`
 * （类叫 AgentObject、键叫 Agent），清单里记的是键 `Agent`，而模块只导出 `AgentObject`——构建成功、
 * 部署时 workerd 抛 `does not provide an export named 'Agent'`。
 *
 * 这一步必须在构建期挡住：`project()` 只是拼字符串、不执行 glue，所以构建机发现不了；
 * 而含 DO 的 Worker 又没有版本预览地址，部署前的 `/healthz` 健康检查会被跳过，
 * 于是坏版本一路切到线上。等线上报错时，作者拿到的是一句 workerd 语法错误，很难归因。
 */
function assertDurableObjectExports(def: PluginDefinition<unknown>, mod: Record<string, unknown>): void {
  const declared = Object.keys(def.durableObjects ?? {})
  if (declared.length === 0) return

  const missing = declared.filter((name) => typeof mod[name] !== 'function')
  if (missing.length === 0) return

  // 常见写法是「键写成投影想要的名字，值指向另一个类名」，把可能的候选说出来
  const exported = Object.keys(mod).filter((k) => k !== 'default' && typeof mod[k] === 'function')
  const hint = exported.length
    ? `入口当前导出的类：${exported.join('、')}\n` +
      `  若类名与键名不同，请把类直接命名为 \`${missing[0]}\` 并写成 \`durableObjects: { ${missing[0]} }\`，` +
      '或把键改成与导出一致的名字。'
    : '入口没有导出任何类。'

  throw new Error(
    `插件 ${def.name} 的 durableObjects 键名与入口的导出名不一致：${missing.join('、')}\n` +
      `  投影器会按清单里的键名 import（\`import { ${missing[0]} as … } from '插件模块'\`），` +
      '模块里没有同名导出就会在启动时失败。\n' +
      `  ${hint}`,
  )
}

/** 在 Node 中加载插件入口，抽取并校验清单（不写任何文件） */
export async function extractPluginManifest(options: ExtractManifestOptions = {}): Promise<Manifest> {
  const cwd = path.resolve(options.cwd ?? process.cwd())
  const entry = path.resolve(cwd, options.entry ?? 'src/index.ts')

  const pkg = await readPackageJson(cwd)
  const mod = await loadModule(entry, cwd, options.alias)
  if (!isPluginDefinition(mod['default'])) {
    throw new Error(`入口必须默认导出 definePlugin(...)：${path.relative(cwd, entry)}`)
  }
  const def = mod['default']
  // 先于清单提取：导出名不对的话，后面产出的清单看着完全合法，问题只在部署时才炸
  assertDurableObjectExports(def, mod)
  const manifest = extractManifest(def, pkg)

  const errors = validateManifest(manifest)
  // name 是路由 /p/<name>/、KV 前缀与表前缀，必须与包名对得上，否则装两个包会撞前缀
  if (pkg.name) {
    const expected = expectedPluginName(pkg.name)
    if (manifest.name !== expected) {
      errors.push(
        `name 与包名不一致：package.json 是 "${pkg.name}"，期望 name 为 "${expected}"，实际为 "${manifest.name}"。` +
          `约定包名为 qflarebot-plugin-<name>，definePlugin 里用去掉前缀的短名`,
      )
    }
  }
  if (errors.length > 0) throw new ManifestValidationError(errors)
  // 放在这里而不是 CLI 里：机器人的构建机直接调 buildPlugin，不经过 CLI，告警也得进它的构建日志。
  // 带上插件名，因为一次构建日志里有好几个插件
  for (const warning of cronWarnings(manifest)) console.warn(`  ⚠ ${warning}`)
  return manifest
}
