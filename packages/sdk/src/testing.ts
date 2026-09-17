/**
 * 插件单元测试工具：构造假的 Session / PluginContext，记录插件的出站行为。
 * 不依赖运行时，`vitest` 中直接调用插件处理器即可。
 */
import type { BotApi, Logger, PluginContext, ScopedDB, ScopedKV } from './context.js'
import type { EventName } from './events.js'
import type {
  Attachment,
  OutgoingMessage,
  Scene,
  SendResult,
  SendTarget,
  Session,
} from './session.js'
import type { CommandInput, PluginDefinition } from './plugin.js'

export interface MockSessionOptions {
  content?: string
  scene?: Scene
  event?: EventName
  targetId?: string
  userId?: string
  userName?: string
  messageId?: string
  botId?: string
  raw?: unknown
  attachments?: Attachment[]
}

export interface MockSession extends Session {
  /** 按调用顺序记录的 reply */
  readonly replies: OutgoingMessage[]
  /** 按调用顺序记录的 send */
  readonly sent: Array<{ message: OutgoingMessage; target: SendTarget | undefined }>
}

export function createMockSession(options: MockSessionOptions = {}): MockSession {
  const replies: OutgoingMessage[] = []
  const sent: MockSession['sent'] = []
  const ok: SendResult = { ok: true, status: 200, messageId: 'mock-msg', raw: {} }

  return {
    botId: options.botId ?? 'test-bot',
    platform: 'qq',
    event: options.event ?? 'qq.group.at_message',
    rawType: 'GROUP_AT_MESSAGE_CREATE',
    id: 'mock-event-id',
    timestamp: Date.now(),
    raw: options.raw ?? {},
    scene: options.scene ?? 'group',
    targetId: options.targetId ?? 'mock-group',
    userId: options.userId ?? 'mock-user',
    userName: options.userName ?? '测试用户',
    messageId: options.messageId ?? 'mock-message-id',
    content: options.content ?? '',
    attachments: options.attachments ?? [],
    replies,
    sent,
    async reply(message) {
      replies.push(message)
      return ok
    },
    async send(message, target) {
      sent.push({ message, target })
      return ok
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

export function createRecordingApi(): BotApi & { readonly calls: Array<{ method: string; path: string; body?: unknown }> } {
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  return {
    calls,
    async raw(method, path, body) {
      calls.push({ method, path, body })
      return { status: 200, data: {} as never }
    },
    async sendMessage() {
      return { ok: true, status: 200, raw: {} }
    },
    async uploadMedia() {
      return { fileInfo: 'mock-file-info', fileUuid: 'mock-uuid', ttl: 86400 }
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
  const db: ScopedDB = options.db ?? {
    table: (n) => `p_${plugin.name}_${n}`,
    exec: async () => {
      throw new Error('mock 环境未提供 db，请通过 createMockContext 的 options.db 注入')
    },
    run: async () => {
      throw new Error('mock 环境未提供 db')
    },
    all: async () => {
      throw new Error('mock 环境未提供 db')
    },
    first: async () => {
      throw new Error('mock 环境未提供 db')
    },
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
