import { QQBotClient } from '@qqbot/api'
import type { Logger, Session } from '@qqbot/sdk'
import { ContextFactory } from './context.js'
import { dispatch, type DispatchReport } from './dispatcher.js'
import { ensureReady } from './lifecycle.js'
import type { PluginRegistry } from './registry.js'
import { buildSession, type Sender } from './session.js'
import { kvTokenCache, profileOf, readBotConfig, readSnapshot } from './store.js'
import type { BotConfig, ResolvedOptions, RuntimeEnv, Snapshot } from './types.js'
import type { WebhookPayload } from '@qqbot/api'

/** 一次请求（或一次 cron 触发）内共享的依赖 */
export class RequestScope {
  private constructor(
    readonly env: RuntimeEnv,
    readonly execCtx: ExecutionContext,
    readonly snapshot: Snapshot,
    readonly bot: BotConfig | null,
    readonly api: QQBotClient | null,
    readonly contexts: ContextFactory,
    private readonly registry: PluginRegistry,
    private readonly options: ResolvedOptions,
    private readonly logger: Logger,
  ) {}

  static async create(
    env: RuntimeEnv,
    execCtx: ExecutionContext,
    registry: PluginRegistry,
    options: ResolvedOptions,
    logger: Logger,
  ): Promise<RequestScope> {
    const [snapshot, bot] = await Promise.all([readSnapshot(env), readBotConfig(env)])
    const api = bot
      ? new QQBotClient({ appId: bot.appId, secret: bot.secret, tokenCache: kvTokenCache(env), fetchImpl: options.fetchImpl })
      : null
    const contexts = new ContextFactory({
      env,
      execCtx,
      registry,
      snapshot,
      botId: bot?.appId ?? 'unconfigured',
      api: api ?? unavailableApi(),
    })
    return new RequestScope(env, execCtx, snapshot, bot, api, contexts, registry, options, logger)
  }

  get botId(): string {
    return this.bot?.appId ?? 'unconfigured'
  }

  /** 把 QQ 事件变成 Session 并分发；`sender` 可替换为记录器实现 dry-run */
  async dispatchPayload(
    payload: WebhookPayload,
    sender?: Sender,
  ): Promise<{ session: Session; report: DispatchReport; outbox: number; failed: number }> {
    let outbox = 0
    let failed = 0
    const inner: Sender = sender ?? this.api ?? unavailableApi()
    // 显式委托而不是展开：QQBotClient 的方法在原型上，展开会丢
    const counting: Sender = {
      sendMessage: async (t, m, o) => {
        const r = await inner.sendMessage(t, m, o)
        if (r.ok) outbox += 1
        else failed += 1
        return r
      },
      ...(inner.typing && { typing: inner.typing.bind(inner) }),
      ...(inner.streamChunk && { streamChunk: inner.streamChunk.bind(inner) }),
      ...(inner.recallMessage && { recallMessage: inner.recallMessage.bind(inner) }),
      ...(inner.ackInteraction && { ackInteraction: inner.ackInteraction.bind(inner) }),
    }
    const profile = profileOf(this.snapshot, this.bot?.appId)
    const session = buildSession(payload, {
      botId: this.botId,
      botName: profile?.name ?? '',
      botAvatar: profile?.avatar ?? '',
      sender: counting,
      maxPassiveReplies: this.options.maxPassiveReplies,
    })
    const report = await dispatch(session, {
      registry: this.registry,
      snapshot: this.snapshot,
      contexts: this.contexts,
      commandPrefixes: this.options.commandPrefixes,
      logger: this.logger,
      prepare: (plugin, def) => ensureReady(plugin, def, this.env, this.contexts, this.logger),
    })
    return { session, report, outbox, failed }
  }
}

/** 机器人未配置时的占位实现：所有出站调用都返回明确错误 */
function unavailableApi(): QQBotClient {
  const error = '机器人尚未配置 AppID/AppSecret'
  return {
    appId: '',
    raw: async () => {
      throw new Error(error)
    },
    uploadMedia: async () => {
      throw new Error(error)
    },
    sendMessage: async () => ({ ok: false, status: 0, error, raw: null }),
  } as unknown as QQBotClient
}
