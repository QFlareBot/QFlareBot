import {
  meetsPermission,
  pluginToolMetadata,
  stableJson,
  validateToolValue,
  validateManifest,
} from '@qqbot/sdk'
import type {
  PluginContext,
  PluginDefinition,
  PluginToolCallOptions,
  PluginToolDescriptor,
  PluginToolRegistry,
  PluginToolResult,
  ToolActor,
  ToolInvocation,
} from '@qqbot/sdk'
import type { PluginRegistry, RegisteredPlugin } from './registry.js'
import type { RuntimeEnv, Snapshot } from './types.js'
import { botAdminsOf } from './botAdmins.js'
import { readBotConfig } from './store.js'
import { createLogger } from './logger.js'

interface Ticket {
  v: 1
  botId: string
  consumer: string
  actor: ToolActor
  nonce: string
  issuedAt: number
  expiresAt: number
}

interface Options {
  env: RuntimeEnv
  botId: string
  registry: PluginRegistry
  snapshot: Snapshot
  refreshSnapshot?: () => Promise<Snapshot>
  actor: () => ToolActor | undefined
  service: (plugin: RegisteredPlugin, name: string) => Promise<unknown>
  prepare: (
    plugin: RegisteredPlugin,
  ) => Promise<{ def: PluginDefinition<unknown>; ctx: PluginContext<unknown> }>
}

const TOKEN_TTL = 24 * 3600_000
const logger = createLogger('tools')
const encoder = new TextEncoder()
const failure = (
  code: string,
  message: string,
  status: PluginToolResult['status'] = 'failed',
  retryable = false,
): PluginToolResult => ({ status, error: { code, message, retryable } })
const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2, '0')).join('')
const digest = async (text: string) =>
  hex(await crypto.subtle.digest('SHA-256', encoder.encode(text)))
const toBase64 = (value: string) =>
  btoa([...encoder.encode(value)].map(c => String.fromCharCode(c)).join(''))
const fromBase64 = (value: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(value), c => c.charCodeAt(0)))

function groupAllowed(snapshot: Snapshot, plugin: string, actor: ToolActor): boolean {
  const groups = snapshot.plugins[plugin]?.groups
  if (!groups || actor.scene !== 'group') return true
  const listed = groups.ids.includes(actor.targetId)
  return groups.mode === 'allow' ? listed : !listed
}

/** 每个 RequestScope 一份；只缓存元数据/本请求调用，不把用户或服务对象放进 isolate 全局。 */
export class ToolRegistryHost {
  private key?: Promise<CryptoKey>
  private catalog?: Promise<PluginToolDescriptor[]>
  private readonly executingProviders = new Map<string, number>()
  private readonly calls = new Map<
    string,
    { fingerprint: string; result: Promise<PluginToolResult> }
  >()

  constructor(private readonly options: Options) {}

  for(consumer: string): PluginToolRegistry {
    return {
      contractVersion: 1,
      capture: () => this.capture(consumer),
      list: invocation => this.list(consumer, invocation),
      describe: async (id, invocation) =>
        (await this.list(consumer, invocation)).find(t => t.id === id) ?? null,
      invoke: (id, input, options) => this.invoke(consumer, id, input, options),
    }
  }

  /** 管理 API 的目录也走同一份清单。 */
  all(): Promise<PluginToolDescriptor[]> {
    return (this.catalog ??= (async () => {
      const result: PluginToolDescriptor[] = []
      for (const plugin of this.options.registry.all()) {
        try {
          if (validateManifest(plugin.manifest).length) continue
        } catch {
          continue
        } // 一个畸形清单不能拖垮所有提供者的目录。
        for (const spec of plugin.manifest.tools ?? []) {
          const id = `${plugin.manifest.name}.${spec.name}`
          const revision = await digest(
            stableJson({
              provider: plugin.manifest.name,
              version: plugin.manifest.version,
              source: plugin.origin?.source ?? null,
              spec,
            }),
          )
          result.push({
            ...spec,
            id,
            owner: plugin.manifest.name,
            revision,
            timeoutMs: spec.timeoutMs ?? 10_000,
          })
        }
      }
      return result.sort((a, b) => a.id.localeCompare(b.id))
    })())
  }

  private signingKey(): Promise<CryptoKey> {
    return (this.key ??= (async () => {
      const bot = await readBotConfig(this.options.env)
      if (!bot?.secret || bot.appId !== this.options.botId)
        throw new Error('机器人凭证不可用，无法签发工具调用上下文')
      return crypto.subtle.importKey(
        'raw',
        encoder.encode(`qflarebot/core.tools/v1:${bot.secret}`),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign', 'verify'],
      )
    })())
  }

  private async capture(consumer: string): Promise<ToolInvocation> {
    if (this.executingProviders.has(consumer))
      throw new Error('工具 handler 不能再次签发调用上下文')
    const actor = this.options.actor()
    if (!actor?.userId || !actor.targetId)
      throw new Error('当前没有用户事件，不能为 cron 或 HTTP 请求伪造工具调用身份')
    if (
      this.options.snapshot.safeMode ||
      this.options.snapshot.plugins[consumer]?.enabled === false ||
      !groupAllowed(this.options.snapshot, consumer, actor)
    )
      throw new Error('调用插件在当前会话未启用')
    const ticket: Ticket = {
      v: 1,
      botId: this.options.botId,
      consumer,
      actor: { ...actor },
      nonce: crypto.randomUUID(),
      issuedAt: Date.now(),
      expiresAt: Date.now() + TOKEN_TTL,
    }
    const payload = toBase64(JSON.stringify(ticket))
    const signature = await crypto.subtle.sign(
      'HMAC',
      await this.signingKey(),
      encoder.encode(payload),
    )
    return { token: `${payload}.${hex(signature)}` }
  }

  private async verify(consumer: string, invocation: ToolInvocation): Promise<Ticket> {
    if (!invocation || typeof invocation.token !== 'string' || invocation.token.length > 8192)
      throw new Error('缺少有效的工具调用上下文')
    const [payload, signature, extra] = invocation.token.split('.')
    if (!payload || !signature || extra !== undefined || !/^[a-f0-9]{64}$/.test(signature))
      throw new Error('工具调用上下文格式无效')
    const bytes = Uint8Array.from(signature.match(/../g)!, n => parseInt(n, 16))
    if (
      !(await crypto.subtle.verify('HMAC', await this.signingKey(), bytes, encoder.encode(payload)))
    )
      throw new Error('工具调用上下文签名无效')
    const ticket = JSON.parse(fromBase64(payload)) as Ticket
    if (
      ticket.v !== 1 ||
      ticket.botId !== this.options.botId ||
      ticket.consumer !== consumer ||
      !ticket.actor?.userId ||
      !ticket.actor.targetId ||
      !Number.isFinite(ticket.expiresAt) ||
      ticket.expiresAt <= Date.now()
    )
      throw new Error('工具调用上下文已过期或不属于当前机器人/插件')
    // 已撤销的 Bot 管理员不能凭旧票据继续获得管理员权限，也不自动扩大旧票据的权限。
    ticket.actor = {
      ...ticket.actor,
      isBotAdmin:
        ticket.actor.isBotAdmin === true &&
        botAdminsOf(this.options.snapshot).includes(ticket.actor.userId),
    }
    return ticket
  }

  private allowed(consumer: string, tool: PluginToolDescriptor, actor?: ToolActor): boolean {
    const { snapshot } = this.options
    const policy = snapshot.toolPolicy
    const access = policy?.consumers?.[consumer]
    if (
      snapshot.safeMode ||
      snapshot.plugins[consumer]?.enabled === false ||
      snapshot.plugins[tool.owner]?.enabled === false ||
      access?.enabled === false ||
      policy?.disabled?.includes(tool.id) ||
      access?.deny?.includes(tool.id)
    )
      return false
    if (access?.allow !== undefined && !access.allow.includes(tool.id)) return false
    if (!actor) return true
    return (
      groupAllowed(snapshot, consumer, actor) &&
      groupAllowed(snapshot, tool.owner, actor) &&
      (!tool.scenes || tool.scenes.includes(actor.scene)) &&
      meetsPermission(actor, tool.permission)
    )
  }

  private async list(
    consumer: string,
    invocation?: ToolInvocation,
  ): Promise<PluginToolDescriptor[]> {
    const actor = invocation ? (await this.verify(consumer, invocation)).actor : undefined
    // 防止消费者修改缓存描述后影响其他消费者或 invoke 的权限检查。
    const catalog = await this.all()
    // 无凭据用于管理/迁移识别：停用工具仍须可见，避免消费者从旧适配器绕回。
    return structuredClone(
      invocation ? catalog.filter(t => this.allowed(consumer, t, actor)) : catalog,
    )
  }

  private async invoke(
    consumer: string,
    id: string,
    rawInput: unknown,
    options: PluginToolCallOptions,
  ): Promise<PluginToolResult> {
    options = {
      ...options,
      invocation: options?.invocation ? { ...options.invocation } : (undefined as never),
    }
    try {
      if (this.options.refreshSnapshot) this.options.snapshot = await this.options.refreshSnapshot()
      if (this.executingProviders.has(consumer))
        return failure('nested_tool_call', 'v1 工具 handler 不允许递归调用其他公开工具')
      const ticket = await this.verify(consumer, options?.invocation)
      const tool = (await this.all()).find(t => t.id === id)
      if (!tool) return failure('unknown_tool', `工具不存在：${id}`)
      if (!this.allowed(consumer, tool, ticket.actor))
        return failure(
          'permission_denied',
          '工具已停用或发起人在当前会话没有权限',
          'permission_denied',
        )
      if (options.expectedRevision !== tool.revision)
        return failure('tool_changed', '工具版本或定义已变化，请重新规划这次调用')
      if (typeof options.callId !== 'string' || !options.callId || options.callId.length > 256)
        return failure('invalid_call_id', 'callId 必须为 1–256 字符')
      let json: string | undefined
      try {
        json = JSON.stringify(rawInput)
      } catch {
        return failure('invalid_input', '工具输入必须是可序列化的 JSON')
      }
      if (!json || encoder.encode(json).length > 65_536)
        return failure('invalid_input', '工具输入必须是 JSON，且不超过 64 KiB')
      const input: unknown = JSON.parse(json)
      const invalid = validateToolValue(tool.inputSchema, input)
      if (invalid) return failure('invalid_input', invalid)
      const key = await digest(
        stableJson([ticket.botId, consumer, ticket.nonce, options.callId, id, tool.revision]),
      )
      const fingerprint = stableJson(input)
      const existing = this.calls.get(key)
      if (existing)
        return existing.fingerprint === fingerprint
          ? structuredClone(await existing.result)
          : failure('call_id_conflict', '同一 callId 不能用于不同参数')
      const result = this.execute(consumer, ticket.actor, tool, input, options, key)
      this.calls.set(key, { fingerprint, result })
      return structuredClone(await result)
    } catch (error) {
      return failure(
        'invalid_invocation',
        error instanceof Error ? error.message : String(error),
        'permission_denied',
      )
    }
  }

  private async execute(
    consumer: string,
    actor: ToolActor,
    tool: PluginToolDescriptor,
    input: unknown,
    options: PluginToolCallOptions,
    key: string,
  ): Promise<PluginToolResult> {
    const startedAt = Date.now()
    const controller = new AbortController()
    const deadline = Math.min(startedAt + tool.timeoutMs, options.deadline ?? Infinity)
    if (options.signal?.aborted) return failure('cancelled', '调用已取消', 'cancelled')
    if (!Number.isFinite(deadline) || deadline <= startedAt)
      return failure('deadline_exceeded', '调用预算已耗尽', 'timeout', true)
    let invoked = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    this.executingProviders.set(tool.owner, (this.executingProviders.get(tool.owner) ?? 0) + 1)
    try {
      const interrupted = new Promise<PluginToolResult>(resolve => {
        const interrupt = (reason: 'cancelled' | 'timeout') => {
          controller.abort(reason)
          const unknown = invoked && tool.sideEffect !== 'none'
          resolve(
            failure(
              unknown ? 'outcome_unknown' : reason,
              unknown
                ? '操作已发出，结果尚未确认；不要自动重试'
                : reason === 'timeout'
                  ? '工具调用超时'
                  : '调用已取消',
              unknown ? 'unknown' : reason,
              !unknown && reason === 'timeout',
            ),
          )
        }
        timer = setTimeout(() => interrupt('timeout'), Math.max(1, deadline - Date.now()))
        onAbort = () => interrupt('cancelled')
        options.signal?.addEventListener('abort', onAbort, { once: true })
      })
      const execution = (async (): Promise<PluginToolResult> => {
        const provider = this.options.registry.get(tool.owner)!
        const { def, ctx } = await this.options.prepare(provider)
        if (controller.signal.aborted) return failure('cancelled', '调用已取消', 'cancelled')
        const implementation = def.tools?.[tool.name]
        const manifestSpec = provider.manifest.tools?.find(t => t.name === tool.name)
        if (!implementation) return failure('tool_unavailable', '清单中的工具没有对应的实现')
        if (
          stableJson(pluginToolMetadata(tool.name, implementation)) !== stableJson(manifestSpec)
        ) {
          return failure('tool_changed', '工具实现声明与部署清单不一致')
        }
        const call = {
          ctx,
          input,
          actor: Object.freeze({ ...actor }),
          caller: Object.freeze({ plugin: consumer, botId: this.options.botId }),
          callId: options.callId,
          idempotencyKey: key,
          signal: controller.signal,
          deadline,
        }
        let returned: PluginToolResult
        if (implementation.service !== undefined) {
          if (implementation.handler || typeof implementation.mapOutput !== 'function') {
            return failure('tool_unavailable', '服务工具需要独立的 mapOutput')
          }
          const instance = await this.options.service(provider, implementation.service)
          const method =
            instance == null ? undefined : Reflect.get(Object(instance), implementation.method)
          if (typeof method !== 'function')
            return failure('tool_unavailable', '绑定的服务方法不存在')
          const args = implementation.mapInput ? await implementation.mapInput(call) : [input]
          if (!Array.isArray(args)) return failure('invalid_arguments', 'mapInput 必须返回参数数组')
          if (controller.signal.aborted) return failure('cancelled', '调用已取消', 'cancelled')
          invoked = true
          const value: unknown = await Reflect.apply(method, instance, args)
          returned = await implementation.mapOutput(value)
        } else {
          if (typeof implementation.handler !== 'function')
            return failure('tool_unavailable', '工具缺少 handler')
          invoked = true
          returned = await implementation.handler(call)
        }
        // 统一返回 JSON 数据，避免 Date/函数等在返回或持久化阶段再抛错，丢失写入状态。
        const result = JSON.parse(JSON.stringify(returned)) as PluginToolResult
        const error = resultError(result, tool)
        if (error)
          return failure('invalid_result', error, tool.sideEffect === 'none' ? 'failed' : 'unknown')
        if (
          tool.sideEffect !== 'none' &&
          (result.status === 'timeout' || result.status === 'cancelled')
        ) {
          return failure('outcome_unknown', '操作已发出，结果尚未确认；不要自动重试', 'unknown')
        }
        if (result.status === 'unknown') result.error = { ...result.error!, retryable: false }
        return result
      })().catch((error: unknown) =>
        failure(
          invoked && tool.sideEffect !== 'none' ? 'outcome_unknown' : 'tool_failed',
          error instanceof Error ? error.message : String(error),
          invoked && tool.sideEffect !== 'none' ? 'unknown' : 'failed',
        ),
      )
      const result = await Promise.race([execution, interrupted])
      logger.info('工具调用完成', {
        caller: consumer,
        provider: tool.owner,
        tool: tool.id,
        callId: options.callId,
        status: result.status,
        code: result.error?.code,
        durationMs: Date.now() - startedAt,
      })
      // 丢失执行结果时保持禁止递归，直到底层 handler 真正结束；不把超时误认为取消成功。
      void execution.finally(() => {
        const count = (this.executingProviders.get(tool.owner) ?? 1) - 1
        if (count) this.executingProviders.set(tool.owner, count)
        else this.executingProviders.delete(tool.owner)
      })
      return result
    } finally {
      if (timer) clearTimeout(timer)
      if (onAbort) options.signal?.removeEventListener('abort', onAbort)
    }
  }
}

function resultError(value: PluginToolResult, tool: PluginToolDescriptor): string | null {
  if (
    !value ||
    !['success', 'failed', 'permission_denied', 'cancelled', 'timeout', 'unknown'].includes(
      value.status,
    )
  )
    return '工具返回值缺少有效 status'
  if (
    value.status !== 'success' &&
    (!value.error ||
      typeof value.error.code !== 'string' ||
      typeof value.error.message !== 'string' ||
      typeof value.error.retryable !== 'boolean')
  )
    return '失败结果必须包含结构化 error'
  const json = JSON.stringify(value)
  if (encoder.encode(json).length > 2_500_000) return '工具返回值超过 2.5 MB，请使用文件 URL'
  if (value.artifacts !== undefined) {
    if (!Array.isArray(value.artifacts) || value.artifacts.length > 10)
      return 'artifacts 必须是至多 10 项的数组'
    for (const item of value.artifacts) {
      if (
        !item ||
        !['image', 'file', 'voice', 'video'].includes(item.type) ||
        (!item.url && !item.base64)
      )
        return '附件类型或来源无效'
      if (item.url && (typeof item.url !== 'string' || !/^https?:\/\//.test(item.url)))
        return '附件 URL 必须使用 HTTP(S)'
      if (
        (item.filename !== undefined && typeof item.filename !== 'string') ||
        (item.caption !== undefined && typeof item.caption !== 'string')
      )
        return '附件 filename/caption 必须是字符串'
      if (
        item.base64 &&
        (typeof item.base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.base64))
      )
        return '附件 base64 无效'
    }
  }
  return value.status === 'success' && tool.outputSchema
    ? validateToolValue(tool.outputSchema, value.output)
    : null
}
