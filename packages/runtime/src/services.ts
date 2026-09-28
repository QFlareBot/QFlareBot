/**
 * 插件之间的服务：可选依赖怎么认、同名服务由谁提供。
 * 服务解析（ContextFactory）、分发时加载提供者（dispatcher）、安装校验与面板都按这里的规则，免得各算各的。
 */
import type { Manifest } from '@qqbot/sdk'
import type { PluginRegistry } from './registry.js'
import type { Snapshot } from './types.js'

/**
 * depends 的值写这个即可选依赖：没有提供者、提供者停用都照常装、照常跑，`ctx.service()` 取不到时抛错。
 * 写在值里而不是另开字段：老版本的机器人只认键，会把它当必需依赖——缺了拒装、装了照常能用，不会装上之后才出错
 */
export const OPTIONAL_DEPENDENCY = 'optional'

export function isOptionalDependency(range: unknown): boolean {
  return typeof range === 'string' && range.trim() === OPTIONAL_DEPENDENCY
}

/** 必需的依赖（服务名） */
export function requiredDepends(manifest: Pick<Manifest, 'depends'>): string[] {
  return Object.entries(manifest.depends ?? {})
    .filter(([, range]) => !isOptionalDependency(range))
    .map(([name]) => name)
}

/** 可选的依赖（服务名） */
export function optionalDepends(manifest: Pick<Manifest, 'depends'>): string[] {
  return Object.entries(manifest.depends ?? {})
    .filter(([, range]) => isOptionalDependency(range))
    .map(([name]) => name)
}

function enabled(snapshot: Snapshot, name: string): boolean {
  return snapshot.plugins[name]?.enabled ?? true
}

/** 面板上选的提供者；没选或选的已经不提供这个服务了为 undefined */
export function selectedProvider(registry: PluginRegistry, snapshot: Snapshot, service: string): string | undefined {
  const chosen = snapshot.serviceProviders?.[service]
  return typeof chosen === 'string' && registry.providersOf(service).includes(chosen) ? chosen : undefined
}

/**
 * 这次由谁提供 service：面板选了就用选的（停用了也不换，报错比悄悄换人好查）；
 * 没选就用先注册、且启用着的那个，都停用了回到先注册的——必需依赖据此报出「未启用」，可选依赖在解析时吞掉
 */
export function providerFor(registry: PluginRegistry, snapshot: Snapshot, service: string): string | undefined {
  const providers = registry.providersOf(service)
  if (providers.length === 0) return undefined
  return selectedProvider(registry, snapshot, service) ?? providers.find((p) => enabled(snapshot, p)) ?? providers[0]
}

/** 面板的「服务」列表：每个服务有哪些提供者、选了谁、现在由谁提供 */
export function serviceOverview(registry: PluginRegistry, snapshot: Snapshot) {
  return registry
    .serviceNames()
    .sort()
    .map((name) => ({
      name,
      providers: [...registry.providersOf(name)],
      selected: selectedProvider(registry, snapshot, name) ?? null,
      active: providerFor(registry, snapshot, name) ?? null,
    }))
}
