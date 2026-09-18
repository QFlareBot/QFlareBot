import { handleAdmin } from './admin.js'
import { serveAsset } from './assets.js'
import { cronMatches } from './cron.js'
import { isEnabled } from './dispatcher.js'
import { error, json } from './http.js'
import { ensureReady } from './lifecycle.js'
import { createLogger, errorInfo } from './logger.js'
import { PluginRegistry } from './registry.js'
import { handlePluginRoute, PLUGIN_ROUTE_PREFIX } from './routes.js'
import { RequestScope } from './scope.js'
import type { ResolvedOptions, RuntimeEnv, RuntimeOptions } from './types.js'
import { handleWebhook } from './webhook.js'

export const RUNTIME_VERSION = '0.1.0'

function resolveOptions(options: RuntimeOptions): ResolvedOptions {
  return {
    plugins: options.plugins,
    projection: options.projection,
    ui: options.ui,
    webhookPath: options.webhookPath ?? '/webhook',
    adminPath: options.adminPath ?? '/admin',
    timestampToleranceSec: options.timestampToleranceSec ?? 300,
    dedupeTtlSec: options.dedupeTtlSec ?? 600,
    maxPassiveReplies: options.maxPassiveReplies ?? 5,
    commandPrefixes: options.commandPrefixes ?? ['/'],
    fetchImpl: options.fetchImpl ?? fetch,
  }
}

/**
 * 构造 Worker 导出对象。路由：
 * - POST {webhookPath}   QQ 回调
 * - GET  /healthz        健康检查（部署流水线切流量前调用）
 * - {adminPath}/*        管理 API
 * - /p/<plugin>/*        插件路由
 * - /, /assets/*         管理面板（传入 ui 时）
 */
export function createRuntime(options: RuntimeOptions): ExportedHandler<RuntimeEnv> {
  const resolved = resolveOptions(options)
  const registry = new PluginRegistry(resolved.plugins)
  const logger = createLogger('runtime')

  return {
    async fetch(request, env, execCtx) {
      const url = new URL(request.url)
      const { pathname } = url

      if (pathname === '/healthz') {
        return json({
          ok: true,
          runtime: RUNTIME_VERSION,
          projection: resolved.projection ?? null,
          plugins: registry.all().length,
        })
      }

      try {
        const scope = await RequestScope.create(env, execCtx, registry, resolved, logger)

        if (pathname === resolved.webhookPath) {
          return await handleWebhook(request, scope, resolved, logger)
        }
        if (pathname === resolved.adminPath || pathname.startsWith(resolved.adminPath + '/')) {
          return await handleAdmin(request, scope, { registry, options: resolved, logger, runtimeVersion: RUNTIME_VERSION })
        }
        if (pathname.startsWith(PLUGIN_ROUTE_PREFIX)) {
          return await handlePluginRoute(request, scope, registry, logger)
        }
        if (resolved.ui) {
          const asset = serveAsset(resolved.ui, request, pathname)
          if (asset) return asset
        }
        return error('Not Found', 404)
      } catch (err) {
        logger.error('请求处理异常', { path: pathname, ...errorInfo(err) })
        return error('Internal Error', 500)
      }
    },

    /** 单一 Cron Trigger 按分钟触发，再按各插件声明的表达式分发 */
    async scheduled(event, env, execCtx) {
      const scope = await RequestScope.create(env, execCtx, registry, resolved, logger)
      if (scope.snapshot.safeMode) return
      const now = new Date(event.scheduledTime)

      for (const plugin of registry.all()) {
        const { name } = plugin.manifest
        if (!isEnabled(scope.snapshot, name)) continue
        const jobs = plugin.manifest.cron.filter((j) => cronMatches(j.cron, now))
        if (!jobs.length) continue

        const def = await plugin.load()
        if (!def) continue
        await ensureReady(plugin, def, env, scope.contexts, logger)

        for (const job of jobs) {
          const impl = def.cron?.find((c) => c.name === job.name)
          if (!impl) continue
          try {
            const ctx = await scope.contexts.prepare(plugin)
            await impl.handler({ ctx, job: job.name, scheduledAt: event.scheduledTime })
            logger.info('定时任务完成', { plugin: name, job: job.name })
          } catch (err) {
            logger.error('定时任务失败', { plugin: name, job: job.name, ...errorInfo(err) })
          }
        }
      }
    },
  }
}
