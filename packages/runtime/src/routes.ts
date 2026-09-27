import type { HttpMethod, Logger } from '@qqbot/sdk'
import { authenticate } from './auth.js'
import { isEnabled } from './dispatcher.js'
import { error, matchPath } from './http.js'
import { ensureReady } from './lifecycle.js'
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
 * `auth: 'admin'` 路由返回的 HTML 一律带上这条 CSP，取值与面板里插件页 iframe 的 sandbox 属性
 * （packages/ui/src/pages/PluginUiPage.vue）一致。
 *
 * 面板的「新窗口打开」让插件页成了顶层页面：与面板同源、没有 iframe 的 sandbox，页面脚本读得到
 * localStorage 里的会话令牌。CSP sandbox 让它不管怎么打开都是 opaque origin；在 iframe 里它本来
 * 就是 opaque origin，两边取交集后没有任何行为变化。公开路由不加，保持原样。
 */
const ADMIN_PAGE_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-downloads'

/**
 * 插件 HTTP 路由：`/p/<插件名>/<插件声明的 path>`，插件需处于启用状态，安全模式下一律 503。
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
  // 安全模式跳过全部插件：页面和接口同样是插件代码，事件不跑了、路由照跑就不叫安全模式
  if (scope.snapshot.safeMode) return withCors(error('安全模式已开启，插件路由暂停服务', 503))

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
      // 与事件分发一样先跑生命周期钩子：新装的插件第一次被访问的可能是页面，onInstall 没跑过表就不存在。
      // 放在鉴权之后，匿名请求碰不到 admin 路由的钩子
      await ensureReady(plugin, def, scope.env, scope.contexts, logger)
      const ctx = await scope.contexts.prepare(plugin)
      const res = withCors(await route.handler({ ctx, request, params, authenticated }))
      if (route.auth === 'admin' && (res.headers.get('content-type') ?? '').trim().toLowerCase().startsWith('text/html')) {
        // append 而不是 set：插件自己可能也带了 CSP，两条同时生效
        res.headers.append('content-security-policy', ADMIN_PAGE_CSP)
      }
      return res
    } catch (err) {
      logger.error('插件路由异常', { plugin: name, path: subPath, ...errorInfo(err) })
      return withCors(error('插件路由执行失败', 500))
    }
  }
  return withCors(error('Not Found', 404))
}
