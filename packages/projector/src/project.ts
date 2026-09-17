import { computeIntegrity, verifyIntegrity } from './artifacts.js'
import { RUNTIME_MODULE, assertPluginsValid, generateGlue, pluginModulePath, sortPlugins } from './glue.js'
import { computeProjectionHash } from './hash.js'
import { buildVersionMetadata } from './metadata.js'
import type { DeployManifest, InstalledPlugin, ProjectOptions, Projection } from './types.js'

export const RUNTIME_PACKAGE = '@qqbot/runtime'

/** 清单 → 可上传的模块集合与版本元数据；纯函数，不触碰 Cloudflare */
export async function project(opts: ProjectOptions): Promise<Projection> {
  const { manifest, fetchArtifact } = opts
  assertPluginsValid(manifest.plugins)
  const plugins = sortPlugins(manifest.plugins)

  const [runtimeCode, ...pluginCodes] = await Promise.all([
    fetchArtifact({
      kind: 'runtime',
      name: RUNTIME_PACKAGE,
      version: manifest.core.version,
      source: manifest.core.source ?? `npm:${RUNTIME_PACKAGE}`,
    }),
    ...plugins.map((p) => fetchArtifact({ kind: 'plugin', name: p.name, version: p.version, source: p.source })),
  ])

  const resolvedPlugins: InstalledPlugin[] = await Promise.all(
    plugins.map(async (p, i) => {
      const code = pluginCodes[i] ?? ''
      if (p.integrity) await verifyIntegrity(code, p.integrity, `插件 ${p.name}@${p.version}`)
      return { ...p, integrity: p.integrity ?? (await computeIntegrity(code)) }
    }),
  )
  const resolved: DeployManifest = { core: manifest.core, plugins: resolvedPlugins }
  const hash = await computeProjectionHash(resolved)

  const modules: Record<string, string> = {
    'index.js': generateGlue({ manifest: resolved, hash }),
    [RUNTIME_MODULE]: runtimeCode,
  }
  plugins.forEach((p, i) => {
    modules[pluginModulePath(p.name)] = pluginCodes[i] ?? ''
  })

  const metadata = buildVersionMetadata({
    manifest: resolved,
    bindings: opts.bindings,
    compatibilityDate: opts.compatibilityDate,
    hash,
    ...(opts.compatibilityFlags ? { compatibilityFlags: opts.compatibilityFlags } : {}),
    ...(opts.message !== undefined ? { message: opts.message } : {}),
  })

  return {
    mainModule: 'index.js',
    modules,
    hash,
    metadata,
    integrity: {
      core: await computeIntegrity(runtimeCode),
      plugins: Object.fromEntries(resolvedPlugins.map((p) => [p.name, p.integrity as string])),
    },
  }
}
