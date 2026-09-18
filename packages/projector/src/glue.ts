import type { Manifest } from '@qqbot/sdk'
import { projectionId } from './hash.js'
import type { DeployManifest, DurableObjectExport } from './types.js'

/** 与 @qqbot/sdk 的清单校验一致；同时保证模块文件名安全 */
const PLUGIN_NAME = /^[a-z0-9][a-z0-9-_]{0,63}$/
const JS_IDENT = /^[A-Za-z_$][\w$]*$/

export const RUNTIME_MODULE = 'runtime.js'
export const UI_MODULE = 'ui.js'

export function pluginModulePath(name: string): string {
  return `plugins/${name}.js`
}

export function doExportName(pluginName: string, className: string): string {
  return `P_${pluginName.replace(/[^A-Za-z0-9]/g, '_')}_${className}`
}

export function sortPlugins<T extends { name: string }>(plugins: readonly T[]): T[] {
  return [...plugins].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** 校验插件名唯一且合法、DO 类名可作为 JS 标识符 */
export function assertPluginsValid(plugins: ReadonlyArray<{ name: string; manifest: Manifest }>): void {
  const seen = new Set<string>()
  for (const p of plugins) {
    if (!PLUGIN_NAME.test(p.name)) throw new Error(`插件名非法：${p.name}`)
    if (seen.has(p.name)) throw new Error(`插件名重复：${p.name}`)
    seen.add(p.name)
    // 先挡一道，否则下面取字段只会得到一句没有上下文的 "Cannot read properties of undefined"
    if (!p.manifest?.durableObjects) {
      throw new Error(`插件 ${p.name} 没有清单：请在部署清单里内联 manifest 对象，或让投影器按 source 拉 manifest.json`)
    }
    for (const cls of p.manifest.durableObjects) {
      if (!JS_IDENT.test(cls)) throw new Error(`插件 ${p.name} 的 Durable Object 类名非法：${cls}`)
    }
  }
}

/** 收集全部插件的 DO 类，按插件名、类名排序；导出名冲突时抛错 */
export function collectDurableObjects(
  plugins: ReadonlyArray<{ name: string; manifest: Manifest }>,
): DurableObjectExport[] {
  const out: DurableObjectExport[] = []
  const names = new Map<string, string>()
  for (const p of sortPlugins(plugins)) {
    for (const className of [...p.manifest.durableObjects].sort()) {
      const exportName = doExportName(p.name, className)
      const prev = names.get(exportName)
      if (prev) throw new Error(`Durable Object 导出名冲突：${exportName}（${prev} 与 ${p.name}）`)
      names.set(exportName, p.name)
      out.push({ plugin: p.name, className, exportName })
    }
  }
  return out
}

/** 生成入口模块 index.js */
export function generateGlue(opts: { manifest: DeployManifest; hash: string }): string {
  const plugins = sortPlugins(opts.manifest.plugins)
  assertPluginsValid(plugins)
  const durableObjects = collectDurableObjects(plugins)

  const lines: string[] = [
    '// 由 @qqbot/projector 生成，勿手改',
    `import { createRuntime } from './${RUNTIME_MODULE}'`,
  ]
  if (opts.manifest.ui) lines.push(`import ui from './${UI_MODULE}'`)
  for (const d of durableObjects) {
    lines.push(`export { ${d.className} as ${d.exportName} } from './${pluginModulePath(d.plugin)}'`)
  }
  // 主模块的命名导出只能是处理器或 DO 类，投影哈希不能 export
  lines.push('', `const PROJECTION = ${JSON.stringify(projectionId(opts.hash))}`, '')

  lines.push('const plugins = [')
  for (const p of plugins) {
    lines.push(
      `  { manifest: ${JSON.stringify(p.manifest)}, load: () => import('./${pluginModulePath(p.name)}') },`,
    )
  }
  const runtimeArgs = opts.manifest.ui ? 'plugins, projection: PROJECTION, ui' : 'plugins, projection: PROJECTION'
  lines.push(']', '', `export default createRuntime({ ${runtimeArgs} })`, '')
  return lines.join('\n')
}
