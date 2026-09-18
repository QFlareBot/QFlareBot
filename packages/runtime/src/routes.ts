import type { HttpMethod, Logger } from '@qqbot/sdk'
import { authenticate } from './auth.js'
import { isEnabled } from './dispatcher.js'
import { error, matchPath } from './http.js'
import { errorInfo } from './logger.js'
import type { PluginRegistry } from './registry.js'
import type { RequestScope } from './scope.js'

export const PLUGIN_ROUTE_PREFIX = '/p/'

/**
 * 插件页面运行在 sandbox iframe（opaque origin）里，对同源接口的请求也算跨域。
 * 令牌走 Authorization 头而不是 cookie，所以放开 CORS 不会扩大权限边界。
 */
const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '600',
}

function withCors(response: Response): Response {
  const res = new Response(response.body, response)
  for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v)
  return res
}

/**
 * 插件 HTTP 路由：`/p/<插件名>/<插件声明的 path>`，插件需处于启用状态。
 * `auth: 'admin'` 的路由接受面板登录态或限定本插件的桥接 token。
 */
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

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

  const plugin = registry.get(name)
  if (!plugin || !isEnabled(scope.snapshot, name)) return withCors(error('插件不存在或未启用', 404))
  const def = await plugin.load()
  if (!def) return withCors(error('插件加载失败', 500))

  const method = request.method === 'HEAD' ? 'GET' : (request.method as HttpMethod)
  for (const route of def.routes ?? []) {
    if (route.method !== method) continue
    const params = matchPath(route.path, subPath)
    if (!params) continue

    const auth = await authenticate(request, scope.env.ADMIN_TOKEN)
    const authenticated = auth.admin || auth.bridgePlugin === name
    if (route.auth === 'admin' && !authenticated) return withCors(error('需要登录', 401))

    try {
      const ctx = await scope.contexts.prepare(plugin)
      return withCors(await route.handler({ ctx, request, params, authenticated }))
    } catch (err) {
      logger.error('插件路由异常', { plugin: name, path: subPath, ...errorInfo(err) })
      return withCors(error('插件路由执行失败', 500))
    }
  }
  return withCors(error('Not Found', 404))
}
