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

function isPluginDefinition(value: unknown): value is PluginDefinition<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { name?: unknown }).name === 'string'
}

/** 把入口打成 Node 可执行的临时 ESM 文件并 import，取默认导出 */
async function loadDefinition(
  entry: string,
  cwd: string,
  alias: Record<string, string> | undefined,
): Promise<PluginDefinition<unknown>> {
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

    const mod = (await import(pathToFileURL(tmpFile).href)) as { default?: unknown }
    if (!isPluginDefinition(mod.default)) {
      throw new Error(`入口必须默认导出 definePlugin(...)：${path.relative(cwd, entry)}`)
    }
    return mod.default
  } finally {
    await rm(tmpFile, { force: true })
  }
}

/** 在 Node 中加载插件入口，抽取并校验清单（不写任何文件） */
export async function extractPluginManifest(options: ExtractManifestOptions = {}): Promise<Manifest> {
  const cwd = path.resolve(options.cwd ?? process.cwd())
  const entry = path.resolve(cwd, options.entry ?? 'src/index.ts')

  const pkg = await readPackageJson(cwd)
  const def = await loadDefinition(entry, cwd, options.alias)
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
  return manifest
}
