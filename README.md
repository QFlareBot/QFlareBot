# qqbot-workers

运行在 Cloudflare Workers 上的 QQ 官方机器人插件框架。QQ Webhook 已免 IP 白名单，一个 Worker 就是一个永久在线、零服务器的机器人。

```
QQ 开放平台 ──POST /webhook──▶ Worker
                               ├─ Ed25519 验签 · 时间窗 · 事件去重
                               ├─ 标准化为 Session
                               ├─ 中间件链 → 命令 / 正则 / 事件匹配（priority / block）
                               └─ 插件处理器 → session.reply() → QQ OpenAPI
```

## 仓库结构

| 目录 | 包名 | 作用 |
| --- | --- | --- |
| `packages/sdk` | `@qqbot/sdk` | 插件契约：类型、`definePlugin`、`extractManifest`、测试工具。零运行时依赖 |
| `packages/api` | `@qqbot/api` | QQ OpenAPI 客户端：Ed25519 签名/验签、AccessToken、消息与富媒体 |
| `packages/runtime` | `@qqbot/runtime` | Worker 运行时：Webhook 网关、分发器、上下文注入、快照、管理 API、Cron 分发 |
| `packages/projector` | `@qqbot/projector` | 清单 → bundle 投影、Cloudflare Versions API 部署、`qqbot-project` CLI |
| `packages/plugin-cli` | `@qqbot/plugin-cli` | `qqbot-plugin build`：把插件打成单文件 ESM 并抽出 manifest.json |
| `plugins/*` | `qqbot-plugin-*` | 示例插件：echo、multi-reply、image、keyboard（按键面板与回调） |
| `apps/seed` | — | 种子应用：Fork 后连接 Cloudflare 即可部署 |
| `templates/plugin` | — | 插件仓库模板（含发布 workflow） |
| `docs/design.md` | — | 设计决策记录 |
| `docs/capabilities.md` | — | QQ 平台能力 → 插件契约对照表（哪些已封装、哪些走 `api.raw`） |

## 快速开始（本地）

需要 Node ≥ 22（wrangler 要求）与 pnpm 10。

```bash
pnpm install
pnpm test                              # 全部单测
cp apps/seed/.dev.vars.example apps/seed/.dev.vars   # 填 BOT_APPID / BOT_SECRET / ADMIN_TOKEN
pnpm dev                               # wrangler dev，本地 KV/D1/R2
```

不需要真实 QQ 事件也能调试：管理 API 提供干跑接口，返回插件的出站消息而不真正发送。

```bash
curl -H 'authorization: Bearer <ADMIN_TOKEN>' -X POST localhost:8787/admin/test-event \
     -d '{"content":"/echo 你好","scene":"group"}'
```

## 写一个插件

```ts
import { definePlugin } from '@qqbot/sdk'

export default definePlugin<{ greeting: string }>({
  name: 'hello',
  defaultConfig: { greeting: '你好' },
  commands: {
    hello: {
      description: '打招呼',
      async handler({ session, ctx, argText }) {
        await session.reply(`${ctx.config.greeting}，${argText || session.userName}`)
      },
    },
  },
  events: [{ event: 'qq.group.robot_added', handler: ({ session }) => session.send('大家好') }],
  cron: [{ name: 'daily', cron: '0 9 * * *', handler: async ({ ctx }) => { /* 主动推送 */ } }],
})
```

按键与回调：

```ts
import { button, keyboard } from '@qqbot/sdk'

commands: {
  menu: {
    async handler({ session }) {
      await session.reply({
        text: '请选择',
        keyboard: keyboard([[button.callback('确认', 'order:1', { id: 'confirm' }), button.link('帮助', 'https://…')]]),
      })
    },
  },
},
buttons: {
  confirm: {
    async handler({ session, buttonData }) {
      await session.reply(`已确认 ${buttonData}`)   // 走 event_id 被动回复
      return 0                                       // 回应平台的 code；不返回则自动 0
    },
  },
},
```

插件拿到的全部能力都来自注入的 `session` 与 `ctx`（`kv` / `db` / `api` / `logger` / `service()`），不 import 运行时。`session` 还提供 `typing()`、`stream()`、`recall()`、`quote`、`interaction`；`ctx.api.group.*` 是群管理接口。完整对照见 `docs/capabilities.md`。复制 `templates/plugin` 起一个仓库，`qqbot-plugin build` 产出 `dist/plugin.js` + `dist/manifest.json`，推 `v*` 标签即发布到 npm。

## 部署模型

- 用户拥有的是**清单**（装了哪些插件、什么版本、配置），不是代码仓库。
- bundle 由清单**投影**而来：`pnpm --filter @qqbot/seed project` 会构建制品、生成 `apps/seed/dist/index.js` 与 `wrangler.generated.jsonc`；`wrangler deploy --config wrangler.generated.jsonc` 即部署。
- 线上安装插件 = 改清单 → 重新投影 → 通过 Versions API 上传 → 预览健康检查 → 切流量（M2 面板接入）。
- 启用/禁用/改配置只改 KV 快照，不部署：`PATCH /admin/plugins/:name`。

## 运行时路由

| 路径 | 说明 |
| --- | --- |
| `POST /webhook` | QQ 回调地址（在开放平台填 `https://<你的域名>/webhook`） |
| `GET /healthz` | 健康检查，含投影哈希 |
| `/admin/*` | 管理 API，需 `Authorization: Bearer <ADMIN_TOKEN>`；建议再挂 Cloudflare Access |
| `/p/<插件>/*` | 插件自己的 HTTP 路由 |

## 状态

M1：契约、运行时、投影器、CLI、示例、种子均已实现，按键/交互回调/event_id 被动回复/引用/多媒体/流式/撤回/群管理已暴露给插件，单测 120，`wrangler dev` 下静态入口与投影产物都已跑通。Cloudflare Versions API 部署按文档实现，**尚未对线上实测**。面板、D1 清单存储与面板内安装在 M2。详见 `docs/design.md`。

> `@qqbot` 这个 npm scope 只是占位，发布前请改成你自己的。
