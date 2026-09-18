import { computeIntegrity, verifyIntegrity } from './artifacts.js'
import { RUNTIME_MODULE, UI_MODULE, assertPluginsValid, generateGlue, pluginModulePath, sortPlugins } from './glue.js'
import { computeProjectionHash } from './hash.js'
import { buildVersionMetadata } from './metadata.js'
import type { DeployManifest, InstalledPlugin, ProjectOptions, Projection } from './types.js'

export const RUNTIME_PACKAGE = '@qqbot/runtime'
export const UI_PACKAGE = '@qqbot/ui'

/** 清单 → 可上传的模块集合与版本元数据；纯函数，不触碰 Cloudflare */
export async function project(opts: ProjectOptions): Promise<Projection> {
  const { manifest, fetchArtifact } = opts
  assertPluginsValid(manifest.plugins)
  const plugins = sortPlugins(manifest.plugins)

  const [runtimeCode, uiCode, ...pluginCodes] = await Promise.all([
    fetchArtifact({
      kind: 'runtime',
      name: RUNTIME_PACKAGE,
      version: manifest.core.version,
      source: manifest.core.source ?? `npm:${RUNTIME_PACKAGE}`,
    }),
    manifest.ui
      ? fetchArtifact({ kind: 'ui', name: UI_PACKAGE, version: manifest.ui.version, source: manifest.ui.source ?? `npm:${UI_PACKAGE}` })
      : Promise.resolve(null),
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
  if (manifest.ui) resolved.ui = manifest.ui
  const hash = await computeProjectionHash(resolved)

  const modules: Record<string, string> = {
    'index.js': generateGlue({ manifest: resolved, hash }),
    [RUNTIME_MODULE]: runtimeCode,
  }
  if (uiCode !== null) modules[UI_MODULE] = uiCode
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
      ...(uiCode !== null ? { ui: await computeIntegrity(uiCode) } : {}),
      plugins: Object.fromEntries(resolvedPlugins.map((p) => [p.name, p.integrity as string])),
    },
  }
}
