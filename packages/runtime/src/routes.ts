import type { HttpMethod, Logger } from '@qqbot/sdk'
import { isEnabled } from './dispatcher.js'
import { error, matchPath } from './http.js'
import { errorInfo } from './logger.js'
import type { PluginRegistry } from './registry.js'
import type { RequestScope } from './scope.js'

export const PLUGIN_ROUTE_PREFIX = '/p/'

/** 插件 HTTP 路由：`/p/<插件名>/<插件声明的 path>`，插件需处于启用状态 */
export async function handlePluginRoute(
  request: Request,
  scope: RequestScope,
  registry: PluginRegistry,
  logger: Logger,
): Promise<Response> {
  const url = new URL(request.url)
  const rest = url.pathname.slice(PLUGIN_ROUTE_PREFIX.length)
  const slash = rest.indexOf('/')
  const name = slash === -1 ? rest : rest.slice(0, slash)
  const subPath = slash === -1 ? '/' : rest.slice(slash)

  const plugin = registry.get(name)
  if (!plugin || !isEnabled(scope.snapshot, name)) return error('插件不存在或未启用', 404)
  const def = await plugin.load()
  if (!def) return error('插件加载失败', 500)

  for (const route of def.routes ?? []) {
    if (route.method !== (request.method as HttpMethod)) continue
    const params = matchPath(route.path, subPath)
    if (!params) continue
    try {
      const ctx = await scope.contexts.prepare(plugin)
      return await route.handler({ ctx, request, params })
    } catch (err) {
      logger.error('插件路由异常', { plugin: name, path: subPath, ...errorInfo(err) })
      return error('插件路由执行失败', 500)
    }
  }
  return error('Not Found', 404)
}
