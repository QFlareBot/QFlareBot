import { createTokenProvider, type WebhookPayload } from '@qqbot/api'
import type { Logger, OutgoingMessage, SendTarget } from '@qqbot/sdk'
import { error, json, matchPath, readJson } from './http.js'
import type { PluginRegistry } from './registry.js'
import type { RequestScope } from './scope.js'
import type { Sender } from './session.js'
import { readSnapshot, writeBotConfig, writeSnapshot } from './store.js'
import type { PluginState, ResolvedOptions, Snapshot } from './types.js'

export interface AdminDeps {
  registry: PluginRegistry
  options: ResolvedOptions
  logger: Logger
  runtimeVersion: string
}

function authorized(request: Request, token: string): boolean {
  const header = request.headers.get('authorization') ?? ''
  return header === `Bearer ${token}`
}

/** 模拟事件：捕获插件的出站消息而不真正调用 QQ */
function recordingSender(): Sender & { outbox: Array<{ target: SendTarget; message: OutgoingMessage; msgSeq?: number }> } {
  const outbox: Array<{ target: SendTarget; message: OutgoingMessage; msgSeq?: number }> = []
  return {
    outbox,
    async sendMessage(target, message, opts) {
      outbox.push({ target, message, ...(opts?.msgSeq !== undefined ? { msgSeq: opts.msgSeq } : {}) })
      return { ok: true, status: 200, messageId: `dry-run-${outbox.length}`, raw: null }
    },
  }
}

/** 把面板/curl 传来的简化事件包装成 QQ 原始 payload */
function fakePayload(body: Record<string, unknown>): WebhookPayload {
  const scene = (body.scene as string) ?? 'group'
  const targetId = (body.targetId as string) ?? 'test-group'
  const userId = (body.userId as string) ?? 'test-user'
  const content = (body.content as string) ?? ''
  const rawType =
    (body.rawType as string) ??
    ({ group: 'GROUP_AT_MESSAGE_CREATE', c2c: 'C2C_MESSAGE_CREATE', guild: 'AT_MESSAGE_CREATE' }[scene] ?? 'GROUP_AT_MESSAGE_CREATE')
  const id = `test-${Date.now()}`
  return {
    op: 0,
    id: `${rawType}:${id}`,
    t: rawType,
    d: {
      id: `ROBOT-TEST-${id}`,
      content,
      timestamp: new Date().toISOString(),
      author: { id: userId, member_openid: userId, user_openid: userId, username: (body.userName as string) ?? '测试用户' },
      ...(scene === 'group' ? { group_openid: targetId } : {}),
      ...(scene === 'guild' ? { channel_id: targetId, guild_id: (body.guildId as string) ?? 'test-guild' } : {}),
      ...(typeof body.raw === 'object' && body.raw ? (body.raw as object) : {}),
    },
  }
}

/**
 * 管理 API（需 `ADMIN_TOKEN`）：
 * GET  /admin/status              运行状态与插件列表
 * GET  /admin/snapshot            读取快照
 * PUT  /admin/snapshot            整体覆盖快照
 * PATCH /admin/plugins/:name      修改单个插件的 enabled / config / priority
 * PUT  /admin/bot                 保存 AppID/AppSecret（先向 QQ 换 token 验证）
 * POST /admin/test-event          注入模拟事件并返回插件的出站消息（不真正发送）
 */
export async function handleAdmin(request: Request, scope: RequestScope, deps: AdminDeps): Promise<Response> {
  const token = scope.env.ADMIN_TOKEN
  if (!token) return error('管理 API 未启用：请设置 ADMIN_TOKEN', 403)
  if (!authorized(request, token)) return error('未授权', 401)

  const url = new URL(request.url)
  const sub = url.pathname.slice(deps.options.adminPath.length) || '/'
  const method = request.method

  if (method === 'GET' && sub === '/status') {
    return json({
      ok: true,
      runtime: deps.runtimeVersion,
      projection: deps.options.projection ?? null,
      bot: scope.bot ? { appId: scope.bot.appId, source: scope.env.BOT_SECRET ? 'secret' : 'kv' } : null,
      snapshot: { revision: scope.snapshot.revision, safeMode: scope.snapshot.safeMode ?? false },
      plugins: deps.registry.all().map((p) => ({
        name: p.manifest.name,
        version: p.manifest.version,
        enabled: scope.snapshot.plugins[p.manifest.name]?.enabled ?? true,
        error: p.error?.message ?? null,
        commands: p.manifest.commands.map((c) => c.name),
      })),
    })
  }

  if (sub === '/snapshot') {
    if (method === 'GET') return json({ ok: true, snapshot: await readSnapshot(scope.env, true) })
    if (method === 'PUT') {
      const body = await readJson<Snapshot>(request)
      if (!body || typeof body.plugins !== 'object') return error('快照格式错误', 400)
      const current = await readSnapshot(scope.env, true)
      const next = await writeSnapshot(scope.env, { ...body, revision: current.revision })
      return json({ ok: true, snapshot: next })
    }
  }

  const pluginMatch = matchPath('/plugins/:name', sub)
  if (pluginMatch && method === 'PATCH') {
    const name = pluginMatch.name!
    if (!deps.registry.get(name)) return error(`插件不存在：${name}`, 404)
    const patch = await readJson<Partial<PluginState>>(request)
    if (!patch) return error('请求体格式错误', 400)
    const current = await readSnapshot(scope.env, true)
    const state: PluginState = { enabled: true, ...current.plugins[name] }
    if (typeof patch.enabled === 'boolean') state.enabled = patch.enabled
    if ('config' in patch) state.config = patch.config
    if (typeof patch.priority === 'number') state.priority = patch.priority
    const next = await writeSnapshot(scope.env, { ...current, plugins: { ...current.plugins, [name]: state } })
    return json({ ok: true, plugin: name, state, revision: next.revision })
  }

  if (sub === '/bot' && method === 'PUT') {
    const body = await readJson<{ appId?: string; secret?: string }>(request)
    const appId = body?.appId?.trim()
    const secret = body?.secret?.trim()
    if (!appId || !secret) return error('appId 与 secret 不能为空', 400)
    try {
      await createTokenProvider({ appId, secret, fetchImpl: deps.options.fetchImpl }).get()
    } catch (err) {
      return error(`QQ 开放平台鉴权失败：${(err as Error).message}`, 400)
    }
    await writeBotConfig(scope.env, { appId, secret })
    deps.logger.info('机器人凭证已更新', { appId })
    return json({ ok: true, appId })
  }

  if (sub === '/test-event' && method === 'POST') {
    const body = (await readJson(request)) ?? {}
    const sender = recordingSender()
    const { session, report } = await scope.dispatchPayload(fakePayload(body), sender)
    return json({
      ok: true,
      session: { event: session.event, scene: session.scene, content: session.content, userId: session.userId },
      matched: report.matched,
      errors: report.errors,
      outbox: sender.outbox,
    })
  }

  return error('Not Found', 404)
}
