# QFlareBot

[![CI](https://github.com/qflarebot/QFlareBot/actions/workflows/ci.yml/badge.svg)](https://github.com/qflarebot/QFlareBot/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/qflarebot/QFlareBot)](LICENSE)

运行在 Cloudflare Workers 上的 QQ 官方机器人插件框架：零服务器、Fork 即部署、面板装插件。

## 特性

- **零服务器**：走 QQ 开放平台 Webhook，一个 Worker 就是一个常驻在线的机器人，无需 IP 白名单。
- **Fork 即部署**：Bootstrap 工作流的网页向导一次建好 KV / D1 / R2 并完成首次部署。
- **面板装插件**：粘贴仓库链接即可安装、批量更新、卸载；插件在 Workers Builds 上从源码构建，构建失败时线上保持原版本。
- **插件契约**：TypeScript 编写，支持命令、正则、事件、按键回调与定时任务；KV / D1 / R2 按插件隔离。
- **管理面板**：插件开关与配置、事件模拟器、扫码创建机器人、插件自定义页面。

## 部署

1. Fork 本仓库。
2. 运行 **Actions → Bootstrap → Run workflow**，打开运行摘要里的向导链接，按提示填写 Cloudflare API token 与 QQ 机器人凭证。
3. 在 Cloudflare 后台为 Worker 绑定自定义域名（QQ 开放平台无法访问 `*.workers.dev`）。
4. 在 QQ 开放平台把回调地址设为 `https://<你的域名>/webhook`。

Token 权限、无 UI 模式、手动部署与自部署原理见 [apps/seed/README.md](apps/seed/README.md)。

## 写插件

```ts
import { definePlugin } from '@qqbot/sdk'

export default definePlugin<{ greeting: string }>({
  name: 'hello',
  defaultConfig: { greeting: '你好' },
  commands: {
    hello: ({ ctx, argText }) => `${ctx.config.greeting}，${argText || '朋友'}`,
  },
  regex: { '/^ping$/i': () => 'pong' },
})
```

以 [`templates/plugin`](templates/plugin) 为模板新建仓库，运行 `qqbot-plugin build` 生成 `manifest.json` 并提交，然后在面板中粘贴仓库链接安装。完整说明见[插件开发指南](docs/plugin-guide.md)。

## 文档

文档站：<https://qflarebot.github.io>（由 `docs/` 自动构建）。

- [插件开发指南](docs/plugin-guide.md)
- [平台能力对照](docs/capabilities.md)
- [面板与插件页面](docs/ui.md)
- [部署与自部署](apps/seed/README.md)
- [设计决策](docs/design.md)

## 开发

需要 Node ≥ 22 与 pnpm 10。

```bash
pnpm install
pnpm test
cp apps/seed/.dev.vars.example apps/seed/.dev.vars   # 填写 BOT_APPID / BOT_SECRET / ADMIN_TOKEN
pnpm dev                                             # 打开 http://localhost:8787
```

文档站依赖独立于 workspace，本地预览：`cd docs && pnpm install --ignore-workspace && pnpm dev`。

| 目录 | 说明 |
| --- | --- |
| `packages/sdk` | 插件契约与测试工具 |
| `packages/api` | QQ OpenAPI 客户端 |
| `packages/runtime` | Worker 运行时与管理 API |
| `packages/projector` | 清单投影与部署 |
| `packages/plugin-cli` | 插件构建工具 `qqbot-plugin` |
| `packages/ui`、`packages/ui-bridge` | 管理面板与插件页面桥 |
| `plugins/` | 内置与示例插件 |
| `apps/seed` | 部署到 Cloudflare 的 Worker |
| `scripts/bootstrap` | 首次部署引导 |
| `templates/plugin` | 插件仓库模板 |

## 状态

早期版本（0.1）。自部署链路已在线上验证。

## 参与贡献

问题与建议请提 [Issue](https://github.com/qflarebot/QFlareBot/issues)。提交 PR 前请确保 `pnpm build && pnpm -r typecheck && pnpm test` 通过。

## 协议

[GPL-3.0-or-later](LICENSE)。`packages/sdk`、`packages/ui-bridge`、`templates/plugin` 与 `plugins/` 采用 MIT。
