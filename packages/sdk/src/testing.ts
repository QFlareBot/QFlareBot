/**
 * 插件单元测试工具：构造假的 Session / PluginContext，记录插件的出站行为。
 * 不依赖运行时，`vitest` 中直接调用插件处理器即可。
 */
import type { BotApi, GroupApi, Logger, PluginContext, ScopedDB, ScopedKV } from './context.js'
import type { EventName } from './events.js'
import type {
  Attachment,
  Interaction,
  InteractionCode,
  OutgoingMessage,
  Scene,
  SendOptions,
  SendResult,
  SendTarget,
  Session,
  StreamWriter,
} from './session.js'
import type { ButtonInput, CommandInput, PluginDefinition } from './plugin.js'

export interface MockSessionOptions {
  content?: string
  scene?: Scene
  event?: EventName
  rawType?: string
  targetId?: string
  userId?: string
  userName?: string
  messageId?: string | null
  refIndex?: string
  botId?: string
  raw?: unknown
  attachments?: Attachment[]
  interaction?: Partial<Pick<Interaction, 'id' | 'type' | 'buttonId' | 'buttonData' | 'featureId' | 'messageId' | 'feedback'>>
}

export interface MockSession extends Session {
  /** 按调用顺序记录的 reply */
  readonly replies: OutgoingMessage[]
  /** 按调用顺序记录的 send */
  readonly sent: Array<{ message: OutgoingMessage; target: SendTarget | undefined }>
  /** 流式写入的全部片段（含 end） */
  readonly streamed: string[]
  readonly recalled: string[]
  readonly typingSeconds: number[]
  /** 交互 ack 记录 */
  readonly acks: InteractionCode[]
}

const OK: SendResult = { ok: true, status: 200, messageId: 'mock-msg', raw: {} }

export function createMockSession(options: MockSessionOptions = {}): MockSession {
  const replies: OutgoingMessage[] = []
  const sent: MockSession['sent'] = []
  const streamed: string[] = []
  const recalled: string[] = []
  const typingSeconds: number[] = []
  const acks: InteractionCode[] = []

  const messageId = options.messageId === null ? undefined : (options.messageId ?? 'mock-message-id')
  let interaction: Interaction | undefined
  if (options.interaction) {
    const i = options.interaction
    interaction = {
      id: i.id ?? 'mock-interaction',
      type: i.type ?? 'button',
      rawType: 11,
      buttonId: i.buttonId ?? '',
      buttonData: i.buttonData ?? '',
      featureId: i.featureId ?? '',
      messageId: i.messageId ?? '',
      feedback: i.feedback,
      get acked() {
        return acks.length > 0
      },
      async ack(code = 0) {
        acks.push(code)
        return true
      },
    }
  }

  return {
    botId: options.botId ?? 'test-bot',
    platform: 'qq',
    event: options.event ?? (interaction ? 'qq.interaction' : 'qq.group.at_message'),
    rawType: options.rawType ?? (interaction ? 'INTERACTION_CREATE' : 'GROUP_AT_MESSAGE_CREATE'),
    id: 'mock-event-id',
    timestamp: Date.now(),
    raw: options.raw ?? {},
    scene: options.scene ?? 'group',
    targetId: options.targetId ?? 'mock-group',
    userId: options.userId ?? 'mock-user',
    userName: options.userName ?? '测试用户',
    messageId,
    refIndex: options.refIndex,
    canReply: true,
    content: options.content ?? '',
    attachments: options.attachments ?? [],
    interaction,
    replies,
    sent,
    streamed,
    recalled,
    typingSeconds,
    acks,
    async reply(message) {
      replies.push(message)
      return OK
    },
    async send(message, target) {
      sent.push({ message, target })
      return OK
    },
    async typing(seconds = 10) {
      typingSeconds.push(seconds)
      return OK
    },
    stream(): StreamWriter {
      return {
        messageId: 'mock-stream',
        async write(chunk) {
          streamed.push(chunk)
          return OK
        },
        async end(chunk) {
          if (chunk) streamed.push(chunk)
          replies.push(streamed.join(''))
          return OK
        },
      }
    },
    async recall(id) {
      recalled.push(id ?? 'mock-msg')
      return true
    },
  }
}

export function createMemoryKV(): ScopedKV & { readonly data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    async get(key) {
      return data.get(key) ?? null
    },
    async getJSON<T>(key: string) {
      const v = data.get(key)
      return v === undefined ? null : (JSON.parse(v) as T)
    },
    async put(key, value) {
      data.set(key, typeof value === 'string' ? value : JSON.stringify(value))
    },
    async delete(key) {
      data.delete(key)
    },
    async list(prefix = '') {
      return [...data.keys()].filter((k) => k.startsWith(prefix))
    },
  }
}

export function createSilentLogger(): Logger {
  const noop = () => {}
  return { debug: noop, info: noop, warn: noop, error: noop }
}

export interface RecordedCall {
  method: string
  path: string
  body?: unknown
}

/** 记录所有 OpenAPI 调用的假客户端；群管理接口全部走 raw 记录 */
export function createRecordingApi(): BotApi & { readonly calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const record = (method: string, path: string, body?: unknown) => {
    calls.push(body === undefined ? { method, path } : { method, path, body })
  }
  const group: GroupApi = {
    async info(g) {
      record('GET', `/v2/groups/${g}/info`)
      return {}
    },
    async botState(g) {
      record('GET', `/v2/groups/${g}/bot_state`)
      return {}
    },
    async members(g, cursor) {
      record('GET', `/v2/groups/${g}/members?cursor=${cursor ?? ''}`)
      return { members: [], nextCursor: '' }
    },
    async member(g, m) {
      record('GET', `/v2/groups/${g}/members/${m}`)
      return { member_openid: m, username: '', member_role: 'member', bot: false, joined_at: '' }
    },
    async removeMembers(g, ids, o) {
      record('POST', `/v2/groups/${g}/batch_remove_members`, { member_openids: ids, ...o })
      return { failedBlacklist: [] }
    },
    async blacklist(g) {
      record('GET', `/v2/groups/${g}/member_blacklist`)
      return {}
    },
    async updateBlacklist(g, op, ids) {
      record('POST', `/v2/groups/${g}/member_blacklist`, { op, member_openids: ids })
      return { failed: [] }
    },
    async mute(g, ops) {
      record('POST', `/v2/groups/${g}/restrict_chat_setting`, { members: ops })
    },
    async muteState(g) {
      record('GET', `/v2/groups/${g}/restrict_chat_setting`)
      return {}
    },
    async joinRequests(g) {
      record('GET', `/v2/groups/${g}/join_request_list`)
      return []
    },
    async reviewJoinRequest(g, m, decision, id) {
      record('POST', `/v2/groups/${g}/approval_join_request/${m}`, { ...decision, join_request_id: id })
    },
  }
  return {
    calls,
    group,
    async raw(method, path, body) {
      record(method, path, body)
      return { status: 200, data: {} as never }
    },
    async sendMessage(target, message, options?: SendOptions) {
      record('POST', `send:${target.scene}:${target.id}`, { message, options })
      return OK
    },
    async uploadMedia() {
      return { fileInfo: 'mock-file-info', fileUuid: 'mock-uuid', ttl: 86400 }
    },
    async typing(user, seconds) {
      record('POST', `typing:${user}`, { seconds })
      return OK
    },
    async streamChunk(user, content, options) {
      record('POST', `stream:${user}`, { content, options })
      return OK
    },
    async recallMessage(target, id) {
      record('DELETE', `recall:${target.scene}:${target.id}:${id}`)
      return true
    },
    async ackInteraction(id, code = 0) {
      record('PUT', `/interactions/${id}`, { code })
      return true
    },
  }
}

export interface MockContextOptions<C> {
  config?: C
  services?: Record<string, unknown>
  db?: ScopedDB
  botId?: string
}

export function createMockContext<C = unknown>(
  plugin: Pick<PluginDefinition<C>, 'name' | 'version' | 'defaultConfig'>,
  options: MockContextOptions<C> = {},
): PluginContext<C> {
  const services = options.services ?? {}
  const unavailable = async () => {
    throw new Error('mock 环境未提供 db，请通过 createMockContext 的 options.db 注入')
  }
  const db: ScopedDB = options.db ?? {
    table: (n) => `p_${plugin.name}_${n}`,
    exec: unavailable,
    run: unavailable,
    all: unavailable,
    first: unavailable,
  }

  return {
    plugin: { name: plugin.name, version: plugin.version ?? '0.0.0' },
    botId: options.botId ?? 'test-bot',
    config: (options.config ?? plugin.defaultConfig ?? {}) as C,
    logger: createSilentLogger(),
    kv: createMemoryKV(),
    db,
    api: createRecordingApi(),
    service<T>(name: string): T {
      if (!(name in services)) throw new Error(`服务未提供：${name}`)
      return services[name] as T
    },
    waitUntil() {},
  }
}

/** 直接触发插件的某个命令，返回记录了出站行为的 session */
export async function runCommand<C>(
  plugin: PluginDefinition<C>,
  command: string,
  argText = '',
  options: { session?: MockSessionOptions; ctx?: MockContextOptions<C> } = {},
): Promise<MockSession> {
  const cmd = plugin.commands?.[command]
  if (!cmd) throw new Error(`插件 ${plugin.name} 没有命令 ${command}`)
  const session = createMockSession({ content: `/${command} ${argText}`.trim(), ...options.session })
  const ctx = createMockContext(plugin, options.ctx)
  const input: CommandInput<C> = {
    session,
    ctx,
    command,
    args: argText.trim() ? argText.trim().split(/\s+/) : [],
    argText: argText.trim(),
  }
  await cmd.handler(input)
  return session
}

/** 直接触发插件的某个回调按键；返回 session 与处理器返回的 code */
export async function runButton<C>(
  plugin: PluginDefinition<C>,
  buttonId: string,
  buttonData = '',
  options: { session?: MockSessionOptions; ctx?: MockContextOptions<C> } = {},
): Promise<{ session: MockSession; code: number | undefined }> {
  const rule = plugin.buttons?.[buttonId]
  if (!rule) throw new Error(`插件 ${plugin.name} 没有按键 ${buttonId}`)
  const session = createMockSession({
    messageId: null,
    interaction: { buttonId, buttonData },
    ...options.session,
  })
  const ctx = createMockContext(plugin, options.ctx)
  const input: ButtonInput<C> = { session, ctx, interaction: session.interaction!, buttonId, buttonData }
  const code = await rule.handler(input)
  return { session, code: typeof code === 'number' ? code : undefined }
}
