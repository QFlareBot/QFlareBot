import { QQBotClient, createTokenProvider, type WebhookPayload } from '@qqbot/api'
import type { Logger, OutgoingMessage, SendOptions, SendResult, SendTarget } from '@qqbot/sdk'
import { authenticate, issueBridge, issueSession, SESSION_TTL_SEC } from './auth.js'
import {
  checkPluginUpdate,
  handleBuildManifest,
  installManifestPlugin,
  listBuildsStatus,
  triggerBuild,
  uninstallManifestPlugin,
  updatePlugin,
} from './adminManifest.js'
import { purgeOrphan, storageReport } from './adminStorage.js'
import { validateConfig } from './configSchema.js'
import { clearEvents, eventStats, listEvents } from './events.js'
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

/** 模拟事件：捕获插件的全部出站动作而不真正调用 QQ */
interface Outbox {
  messages: Array<{ target: SendTarget; message: OutgoingMessage; options?: SendOptions }>
  acks: Array<{ interactionId: string; code: number }>
  recalls: string[]
  streams: Array<{ index: number; content: string; final: boolean }>
}

function recordingSender(): Sender & { outbox: Outbox } {
  const outbox: Outbox = { messages: [], acks: [], recalls: [], streams: [] }
  const ok = (id: string): SendResult => ({ ok: true, status: 200, messageId: id, raw: null })
  return {
    outbox,
    async sendMessage(target, message, options) {
      outbox.messages.push({ target, message, ...(options ? { options } : {}) })
      return ok(`dry-run-${outbox.messages.length}`)
    },
    async typing() {
      return ok('dry-run-typing')
    },
    async streamChunk(_user, content, options) {
      outbox.streams.push({ index: options.index, content, final: options.final })
      return ok('dry-run-stream')
    },
    async recallMessage(_target, id) {
      outbox.recalls.push(id)
      return true
    },
    async ackInteraction(interactionId, code = 0) {
      outbox.acks.push({ interactionId, code })
      return true
    },
  }
}

/**
 * 把面板/curl 传来的简化事件包装成 QQ 原始 payload。
 * 传 `buttonId` 即构造 INTERACTION_CREATE；否则按 scene 构造消息事件。
 */
function fakePayload(body: Record<string, unknown>): WebhookPayload {
  const scene = (body.scene as string) ?? 'group'
  const targetId = (body.targetId as string) ?? 'test-group'
  const userId = (body.userId as string) ?? 'test-user'
  const id = `test-${Date.now()}`
  const timestamp = new Date().toISOString()
  const extra = typeof body.raw === 'object' && body.raw ? (body.raw as object) : {}

  if (typeof body.buttonId === 'string') {
    return {
      op: 0,
      id: `INTERACTION_CREATE:${id}`,
      t: 'INTERACTION_CREATE',
      d: {
        id,
        type: 11,
        scene,
        chat_type: scene === 'group' ? 1 : scene === 'c2c' ? 2 : 0,
        timestamp,
        data: { type: 11, resolved: { button_id: body.buttonId, button_data: (body.buttonData as string) ?? '' } },
        ...(scene === 'group' ? { group_openid: targetId, group_member_openid: userId } : { user_openid: userId }),
        ...extra,
      },
    }
  }

  const rawType =
    (body.rawType as string) ??
    ({ group: 'GROUP_AT_MESSAGE_CREATE', c2c: 'C2C_MESSAGE_CREATE', guild: 'AT_MESSAGE_CREATE' }[scene] ?? 'GROUP_AT_MESSAGE_CREATE')
  return {
    op: 0,
    id: `${rawType}:${id}`,
    t: rawType,
    d: {
      id: `ROBOT-TEST-${id}`,
      content: (body.content as string) ?? '',
      timestamp,
      author: { id: userId, member_openid: userId, user_openid: userId, username: (body.userName as string) ?? '测试用户' },
      ...(scene === 'group' ? { group_openid: targetId } : {}),
      ...(scene === 'guild' ? { channel_id: targetId, guild_id: (body.guildId as string) ?? 'test-guild' } : {}),
      ...extra,
    },
  }
}

/**
 * 管理 API（需 `ADMIN_TOKEN`）。除 /login 外都要求 Bearer 管理密钥或会话令牌。
 * POST /admin/login                 用管理密钥换 7 天会话令牌
 * GET  /admin/status                运行状态、插件列表（含配置 schema / ui）、事件统计
 * GET  /admin/snapshot              读取快照
 * PUT  /admin/snapshot              整体覆盖快照
 * PATCH /admin/plugins/:name        修改单个插件的 enabled / config / priority
 * POST /admin/plugins/:name/bridge  为插件页面签发 1 小时桥接令牌
 * PUT  /admin/bot                   保存 AppID/AppSecret（先向 QQ 换 token 验证）
 * GET  /admin/events?limit&before   最近事件的分发摘要
 * DELETE /admin/events              清空事件记录
 * POST /admin/test-event            注入模拟事件（消息或按键点击）并返回插件的出站动作（不真正发送）
 * POST /admin/send                  以机器人身份真实发送一条主动消息 { scene, targetId, message }
 * GET  /admin/qq/panels             查看当前 QQ 指令面板（需 scope=c2c|group|channel|dm，游标分页）
 * POST /admin/qq/panels             创建指令面板 { scope, target_type?, group_openids?, user_openids?, panel }
 * DELETE /admin/qq/panels/:panelId  删除指令面板
 * GET  /admin/qq/menu               查看当前自定义菜单（仅单聊场景，全局一份）
 * PUT  /admin/qq/menu               保存自定义菜单 { menu: { items: [...] } }，整体覆盖（5 QPM）
 * POST /admin/qq/url-link           生成机器人分享/邀请链接（/v2/generate_url_link 透传）
 * —— 自部署（构建清单存 D1，构建机经 Builds API 重建，见 adminManifest.ts）——
 * GET  /admin/build-manifest        构建机拉取插件清单 { hash, plugins }；鉴权 BUILD_TOKEN 优先，未配置走管理鉴权
 * POST /admin/manifest/plugins      安装/升级插件 { source: "git:owner/repo@sha[#subdir]" }（校验声明清单、撞名与依赖）
 * POST /admin/manifest/plugins/:name/check-update  解析上游仓库最新 commit，只查不装
 * POST /admin/manifest/plugins/:name/update        升级到上游最新 commit 并自动触发构建
 * DELETE /admin/manifest/plugins/:name[?purge=true]  卸载插件（移出 D1 清单；purge=true 连数据一起清）
 * GET  /admin/storage               各插件的 KV/D1/R2 占用，以及不属于任何已装插件的孤儿数据
 * DELETE /admin/storage/orphans/:name  清掉某个已卸载插件的残留数据
 * POST /admin/builds                触发 Workers Builds 重建（{ branch } 可选），返回 buildUuid
 * GET  /admin/builds                安装/构建账本，顺带同步进行中构建的状态与 commit
 */
export async function handleAdmin(request: Request, scope: RequestScope, deps: AdminDeps): Promise<Response> {
  const url = new URL(request.url)
  const sub = url.pathname.slice(deps.options.adminPath.length) || '/'
  const method = request.method

  // 构建机拉清单：BUILD_TOKEN 优先，未配置时与面板同一鉴权（ADMIN_TOKEN 本身可未配置）；
  // 放在 ADMIN_TOKEN 存在性检查之前，构建清单不随管理 API 一起关闭
  if (method === 'GET' && sub === '/build-manifest') return handleBuildManifest(request, scope)

  const token = scope.env.ADMIN_TOKEN
  if (!token) return error('管理 API 未启用：请设置 ADMIN_TOKEN', 403)

  if (method === 'POST' && sub === '/login') {
    const body = await readJson<{ token?: string }>(request)
    if (body?.token?.trim() !== token) return error('管理密钥不正确', 401)
    return json({ ok: true, session: await issueSession(token), expiresIn: SESSION_TTL_SEC })
  }

  if (!(await authenticate(request, token)).admin) return error('未授权', 401)

  if (method === 'GET' && sub === '/status') {
    const stats = await eventStats(scope.env).catch(() => null)
    return json({
      ok: true,
      runtime: deps.runtimeVersion,
      projection: deps.options.projection ?? null,
      bot: scope.bot ? { appId: scope.bot.appId, source: scope.env.BOT_SECRET ? 'secret' : 'kv' } : null,
      webhookPath: deps.options.webhookPath,
      bindings: { kv: true, d1: !!scope.env.DB, r2: !!scope.env.R2 },
      snapshot: { revision: scope.snapshot.revision, safeMode: scope.snapshot.safeMode ?? false },
      stats,
      plugins: deps.registry.all().map((p) => {
        const state = scope.snapshot.plugins[p.manifest.name]
        return {
          name: p.manifest.name,
          version: p.manifest.version,
          displayName: p.manifest.displayName ?? p.manifest.name,
          description: p.manifest.description ?? '',
          enabled: state?.enabled ?? true,
          priority: state?.priority ?? 0,
          config: state?.config ?? p.manifest.defaultConfig ?? null,
          configSchema: p.manifest.configSchema ?? null,
          permissions: p.manifest.permissions,
          error: p.error?.message ?? null,
          commands: p.manifest.commands,
          events: p.manifest.events.flatMap((e) => e.event),
          buttons: p.manifest.buttons.map((b) => b.id),
          cron: p.manifest.cron,
          routes: p.manifest.routes,
          ui: p.manifest.ui ?? null,
        }
      }),
    })
  }

  if (sub === '/events') {
    if (method === 'GET') {
      const limit = Number(url.searchParams.get('limit')) || 50
      const before = Number(url.searchParams.get('before')) || undefined
      const events = await listEvents(scope.env, { limit, ...(before ? { before } : {}) })
      return json({ ok: true, events })
    }
    if (method === 'DELETE') {
      await clearEvents(scope.env)
      return json({ ok: true })
    }
  }

  if (sub === '/manifest/plugins' && method === 'POST') return installManifestPlugin(request, scope, deps)
  const checkUpdate = matchPath('/manifest/plugins/:name/check-update', sub)
  if (checkUpdate && method === 'POST') return checkPluginUpdate(checkUpdate.name!, scope, deps)
  const pluginUpdate = matchPath('/manifest/plugins/:name/update', sub)
  if (pluginUpdate && method === 'POST') return updatePlugin(pluginUpdate.name!, scope, deps)
  const manifestRemove = matchPath('/manifest/plugins/:name', sub)
  if (manifestRemove && method === 'DELETE') {
    const purge = url.searchParams.get('purge') === 'true'
    return uninstallManifestPlugin(manifestRemove.name!, purge, scope, deps)
  }

  if (sub === '/storage' && method === 'GET') return storageReport(scope, deps)
  const orphanPurge = matchPath('/storage/orphans/:name', sub)
  if (orphanPurge && method === 'DELETE') return purgeOrphan(orphanPurge.name!, scope, deps)

  if (sub === '/builds' && method === 'POST') return triggerBuild(request, scope, deps)
  if (sub === '/builds' && method === 'GET') return listBuildsStatus(scope, deps)

  const bridgeMatch = matchPath('/plugins/:name/bridge', sub)
  if (bridgeMatch && method === 'POST') {
    const name = bridgeMatch.name!
    if (!deps.registry.get(name)) return error(`插件不存在：${name}`, 404)
    return json({ ok: true, token: await issueBridge(token, name) })
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
    const plugin = deps.registry.get(name)
    if (!plugin) return error(`插件不存在：${name}`, 404)
    const patch = await readJson<Partial<PluginState>>(request)
    if (!patch) return error('请求体格式错误', 400)
    // 存之前按 configSchema 校验：否则类型写错要等插件运行时才炸
    if ('config' in patch) {
      const fields = validateConfig(plugin.manifest.configSchema, patch.config)
      if (fields.length > 0) return json({ ok: false, error: '配置不符合 schema', fields }, 400)
    }
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
    // 顺手拉一次机器人资料存进快照，运行时经 session.botName/botAvatar 下发，零额外 API。
    // 拉取失败不影响凭证保存，只是资料为空。
    try {
      const client = new QQBotClient({ appId, secret, fetchImpl: deps.options.fetchImpl })
      const profile = await client.me()
      const snapshot = await readSnapshot(scope.env, true)
      await writeSnapshot(scope.env, {
        ...snapshot,
        bot: {
          name: typeof profile.username === 'string' ? profile.username : '',
          avatar: typeof profile.avatar === 'string' ? profile.avatar : '',
        },
      })
    } catch (err) {
      deps.logger.warn('拉取机器人资料失败，session.botName/botAvatar 将为空', { error: (err as Error).message })
    }
    deps.logger.info('机器人凭证已更新', { appId })
    return json({ ok: true, appId })
  }

  if (sub === '/send' && method === 'POST') {
    if (!scope.api) return error('机器人尚未配置 AppID/AppSecret', 503)
    const body = await readJson<{ scene?: string; targetId?: string; message?: OutgoingMessage }>(request)
    const scene = body?.scene as SendTarget['scene'] | undefined
    const targetId = body?.targetId?.trim()
    if (!scene || !targetId || body?.message === undefined) return error('需要 scene、targetId 与 message', 400)
    const result = await scope.api.sendMessage({ scene, id: targetId }, body.message)
    deps.logger.info('面板主动发送', { scene, targetId, ok: result.ok, status: result.status })
    return json({ ok: result.ok, result }, result.ok ? 200 : 502)
  }

  // —— QQ 机器人全局配置：机器人的"外观"由运营者在面板管理，不走插件契约 ——
  // 字段形状按官方文档（2026-09 实测核对）；平台响应原样回显（HTTP 200 内嵌 status），便于在面板上直接看到平台回复。
  if (sub === '/qq/panels' && (method === 'GET' || method === 'POST')) {
    if (!scope.api) return error('机器人尚未配置 AppID/AppSecret', 503)
    const SCOPES = ['c2c', 'group', 'channel', 'dm']
    if (method === 'GET') {
      const scopeVal = url.searchParams.get('scope') ?? ''
      if (!SCOPES.includes(scopeVal)) return error('需要 scope=c2c|group|channel|dm', 400)
      const q = new URLSearchParams({ scope: scopeVal })
      const cursor = url.searchParams.get('cursor')
      if (cursor) q.set('cursor', cursor)
      const limit = url.searchParams.get('limit')
      if (limit) q.set('limit', limit)
      const { status, data } = await scope.api.raw('GET', `/v2/panels?${q}`)
      deps.logger.info('查询 QQ 指令面板', { scope: scopeVal, status })
      return json({ ok: status > 0 && status < 300, status, data })
    }
    const body = await readJson<{ scope?: string; target_type?: string; panel?: unknown }>(request)
    if (!body || !SCOPES.includes(body.scope ?? '')) return error('需要 scope=c2c|group|channel|dm', 400)
    if (typeof body.panel !== 'object' || !body.panel) return error('需要 panel 配置', 400)
    const { status, data } = await scope.api.raw('POST', '/v2/panels', body)
    deps.logger.info('创建 QQ 指令面板', { scope: body.scope, status })
    return json({ ok: status > 0 && status < 300, status, data })
  }

  const panelRemove = matchPath('/qq/panels/:panelId', sub)
  if (panelRemove && method === 'DELETE') {
    if (!scope.api) return error('机器人尚未配置 AppID/AppSecret', 503)
    const { status, data } = await scope.api.raw('DELETE', `/v2/panels/${panelRemove.panelId}`)
    deps.logger.info('删除 QQ 指令面板', { panelId: panelRemove.panelId, status })
    return json({ ok: status > 0 && status < 300, status, data })
  }

  // 自定义菜单：仅单聊场景、全局一份，PUT 会整体覆盖（5 QPM）
  if (sub === '/qq/menu' && (method === 'GET' || method === 'PUT')) {
    if (!scope.api) return error('机器人尚未配置 AppID/AppSecret', 503)
    if (method === 'GET') {
      const { status, data } = await scope.api.raw('GET', '/v2/menu')
      return json({ ok: status > 0 && status < 300, status, data })
    }
    const body = await readJson<{ menu?: unknown }>(request)
    if (!body || typeof body.menu !== 'object' || !body.menu) return error('需要 menu 配置（items 传空数组即可清空菜单）', 400)
    const { status, data } = await scope.api.raw('PUT', '/v2/menu', body)
    deps.logger.info('保存 QQ 自定义菜单', { status })
    return json({ ok: status > 0 && status < 300, status, data })
  }

  if (sub === '/qq/url-link' && method === 'POST') {
    if (!scope.api) return error('机器人尚未配置 AppID/AppSecret', 503)
    const body = (await readJson(request)) ?? {}
    const { status, data } = await scope.api.raw('POST', '/v2/generate_url_link', body)
    deps.logger.info('生成分享链接', { status })
    return json({ ok: status > 0 && status < 300, status, data })
  }

  if (sub === '/test-event' && method === 'POST') {
    const body = (await readJson(request)) ?? {}
    const sender = recordingSender()
    const { session, report } = await scope.dispatchPayload(fakePayload(body), sender)
    return json({
      ok: true,
      session: {
        event: session.event,
        scene: session.scene,
        content: session.content,
        userId: session.userId,
        canReply: session.canReply,
        interaction: session.interaction ? { type: session.interaction.type, buttonId: session.interaction.buttonId } : null,
      },
      matched: report.matched,
      errors: report.errors,
      outbox: sender.outbox.messages,
      acks: sender.outbox.acks,
      recalls: sender.outbox.recalls,
      streams: sender.outbox.streams,
    })
  }

  return error('Not Found', 404)
}
