# 统一插件工具协议

SDK 契约 v5 新增 `definePlugin.tools` 和框架内置服务 `core.tools`。任何 Agent 插件都能接入同一目录、同一调用入口；提供者只需声明一次，不必依赖某个 Agent。原有 `services` / `depends` 继续用于固定服务依赖。

## 提供者

```ts
import { definePlugin } from '@qqbot/sdk'

export default definePlugin({
  name: 'weather',
  apiVersion: 5,
  services: {
    weather: ctx => ({
      async query(city: string) {
        return { city, weather: await ctx.kv.getJSON(`weather:${city}`) }
      },
    }),
  },
  tools: {
    query: {
      service: 'weather',
      method: 'query',
      description: '读取某城市最近缓存的天气，用于回答天气问题。返回 city 和 weather；weather 为 null 表示暂无数据，不能当作实时天气。',
      inputSchema: {
        type: 'object', required: ['city'], additionalProperties: false,
        properties: {
          city: { type: 'string', description: '城市名称，例如上海。', minLength: 1 },
        },
      },
      permission: 'member',
      sideEffect: 'none',
      version: 1,
      timeoutMs: 10_000,
      mapInput: ({ input }) => [(input as { city: string }).city],
      mapOutput: output => ({ status: 'success', output }),
    },
  },
})
```

优先复用已有 `services`：`service` 必须是本插件提供的服务，`method` 指定一个公开方法。同一请求内与普通 `ctx.service()` 共享实例，保留 `this`；同名服务的工具始终绑定声明它的提供者，不受全局服务选择影响。未标注的方法不会进入目录。

`mapInput` 可选，默认把模型输入对象作为唯一参数；位置参数或取消信号通过它转换。`mapOutput` 必填，把旧返回值明确转换成结构化结果：如果旧接口返回 `{ ok: false }`，必须映射成 `failed`，不能一律包装成功。转换函数只做参数和结果处理，业务副作用留在服务方法中，框架以方法调用开始作为“操作已发出”的边界。

没有现成服务时仍可写 `handler(call)`，与 `service/method` 二选一。`mapInput` 和 `handler` 接收提供者 `ctx`、模型 `input`、原始 `actor`、消费插件 `caller`、`idempotencyKey`、`signal`、`deadline`；旧方法签名无需改动，需要取消/幂等时在参数转换中传入。

说明应包含“做什么、何时用、输入含义、输出含义和限制”，字段说明放在 Schema 的 `description`；可以加 `outputSchema` 校验输出。框架不能仅靠方法名或 TypeScript 注释推断业务用途，不自动生成说明。T2I 的 `render` 声明是完整的现有服务适配示例。

构建器把描述、Schema、绑定目标、权限、副作用、版本和超时写入 manifest，移除 handler/mapInput/mapOutput。目录查询只读 manifest，执行时才加载准确的提供者、准备其服务依赖与生命周期。初始化失败不会进入 handler 或绑定方法。

工具 ID 为 `<插件名>.<工具短名>`，两个插件可以都有 `query`。短名只接受字母、数字、下划线、连字符，1–48 字符。`core.*` 保留给框架，插件不能声明为普通服务。

`permission` 为 `member` / `group_admin` / `bot_admin`，可选 `scenes` 限定场景。`sideEffect` 为 `none` / `workspace_write` / `external_write` / `dangerous`，必须准确声明。危险操作的交互确认由消费 Agent 实现；框架统一复核角色和调用策略，不代替 Agent 的确认界面。

## Agent 消费者

```ts
import { definePlugin, type PluginToolRegistry } from '@qqbot/sdk'

export default definePlugin({
  name: 'my-agent',
  apiVersion: 5,
  depends: { 'core.tools': '*' },
  commands: {
    weather: {
      async handler({ ctx }) {
        const tools = ctx.service<PluginToolRegistry>('core.tools')
        const invocation = await tools.capture()
        const descriptor = await tools.describe('weather.query', invocation)
        if (!descriptor) return '当前用户没有可用的天气工具'
        const result = await tools.invoke(descriptor.id, { city: '上海' }, {
          invocation, callId: crypto.randomUUID(), expectedRevision: descriptor.revision,
        })
        return JSON.stringify(result)
      },
    },
  },
})
```

消费者无须在 `depends` 中逐个添加提供者。服务包装器绑定当前消费插件，参数中不接受自报的 owner、用户身份或管理员标志。普通 `ctx.service()` 仍要求声明依赖。

- `capture()` 只在真实事件上下文签发凭据，绑定机器人、调用插件、发起人、会话和有效期（24 小时）。不能在 cron/HTTP 路由中凭空签发。不要把凭据放进模型提示词、日志或历史展示。
- `list(invocation)` / `describe(id, invocation)` 按调用方策略、发起人权限和群范围过滤；不传凭据返回完整管理目录（包括停用项），不代表有权执行。
- `invoke()` 必须带凭据、稳定 `callId`、目录的 `revision`，可传 `signal` / `deadline`。执行前刷新当前策略，重新检查启用状态、群范围、场景、权限、Schema、版本。
- 群角色沿用签发事件的快照，不能即时感知 QQ 侧随后发生的角色变更；24 小时后必须由新用户事件重新授权。Bot 管理员还须在当前管理员名单内，不会给旧凭据追加新权限。

## 结果与恢复

统一结果包含 `status`、可选 `output` / `artifacts`，失败必须带 `{ code, message, retryable }`。状态为 `success`、`failed`、`permission_denied`、`cancelled`、`timeout`、`unknown`。附件支持 image/file/voice/video，通过 HTTP(S) URL 或 base64 返回；由 Agent 的回复通道交付，提供者不必拿到消费者的 session。

输入限制 64 KiB；结果限制 2.5 MB、至多 10 个附件。大文件用 URL。超时默认 10 秒、最大 30 秒，并受调用方 deadline 限制；传给 handler 的 signal 包含取消和超时，handler 需要配合停止工作。

写操作已进入 handler 或绑定服务方法后发生超时、取消、抛错或无效结果，会返回 `unknown`，`retryable: false`。这表示结果无法确认，不表示操作被撤销。Agent 应停止自动重试，保留调用意图供核对。

恢复需要持久化原始凭据、稳定调用 ID、工具 ID/revision 和已完成结果。框架只在单个请求内合并重复调用；跨请求传递相同幂等键，持久幂等由提供者/后端实现，不保证外部写入 exactly-once。相同 callId 的不同参数在单个请求内会被拒绝。

revision 包含提供者版本、部署来源（若有）和工具声明。升级后旧检查点不能静默切换实现；源码内置或无来源标记的插件修改行为时必须递增插件或工具版本。

## Schema 范围

v1 支持对象/数组/基础类型、properties/required/additionalProperties/items、enum/const、anyOf/oneOf/allOf/not、字符串长度与 pattern、数值范围与 multipleOf、数组长度与 uniqueItems，以及常见说明字段。根输入必须为 object，Schema 最深 16 层。不支持 `$ref`、`format` 等关键词时会拒绝声明，不会忽略约束；不转换类型，不自动补默认值。

## 管理接口

两个端点均要求现有管理员鉴权：

- `GET /admin/tools`：清单、提供者可用状态、当前策略。
- `PUT /admin/tools/policy`：整体替换工具策略，其他快照配置保留。

```json
{
  "disabled": ["admin.delete"],
  "consumers": {
    "agent": { "allow": ["weather.query", "t2i.render"], "deny": [] },
    "another-agent": { "enabled": false }
  }
}
```

省略 `allow` 为不限，`allow: []` 为全部禁止；全局停用、deny、提供者/消费者停用和群范围限制不能被 allow 覆盖。默认可发现所有已启用且权限允许的公开工具。当前提供管理 API，未增加独立的框架工具管理页面。

## v1 边界

工具 handler 内不能递归签发凭据或调用其他公开工具；需要组合能力时先复用静态 services。新定时任务需要独立授权设计，不能冒用 cron 的身份。恢复原任务可以沿用未过期的凭据。

插件仍在同一个 Worker isolate 中运行，本协议提供统一入口和调用约束，不构成恶意插件代码的沙箱。T2I 已提供 `t2i.render`，原 `t2i` 服务继续可用。
