<picture>
  <source media="(prefers-color-scheme: dark)" srcset="design-system/qflarebot/brand/logo-dark.svg">
  <img src="design-system/qflarebot/brand/logo.svg" alt="QFlareBot" width="88" height="88">
</picture>

# QFlareBot

[![Release](https://img.shields.io/github/v/release/QFlareBot/QFlareBot?sort=semver&include_prereleases)](https://github.com/QFlareBot/QFlareBot/releases)
[![CI](https://github.com/QFlareBot/QFlareBot/actions/workflows/ci.yml/badge.svg)](https://github.com/QFlareBot/QFlareBot/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-qflarebot.github.io-blue)](https://qflarebot.github.io)
[![License](https://img.shields.io/github/license/QFlareBot/QFlareBot)](LICENSE)

运行在 Cloudflare Workers 上的 QQ 官方机器人插件框架：零服务器、Fork 即部署、面板装插件。

**文档：<https://qflarebot.github.io>**

## 特点

- **零服务器**：走 QQ 开放平台 Webhook，一个 Worker 就是一个常驻在线的机器人，免费版 Cloudflare 账号就能跑。
- **Fork 即部署**：运行仓库里的 Bootstrap 工作流，跟着网页向导建好 KV / D1 / R2 并完成首次部署。
- **面板装插件**：粘贴仓库链接，或在「市场」里勾选几个一起装；插件在 Workers Builds 上从源码构建，构建失败时线上保持原版本。
- **插件能力完整**：命令、正则、事件、按键回调、定时任务、按插件隔离的 KV / D1 / R2，插件还可以自带 Web 页面。
- **升级就是同步上游**：在你的 Fork 上点 Sync fork，机器人自动重建，面板里装的插件都还在。

## 部署前要准备

- 一个 Cloudflare 账号（免费版即可）和一个 GitHub 账号。
- **一个托管在 Cloudflare 上的域名**：QQ 开放平台访问不到 `*.workers.dev`，回调必须走你自己的域名。
- QQ 机器人不用提前准备，部署完在面板里用手机 QQ 扫码新建。

步骤见[快速部署](https://qflarebot.github.io/deploy)。

## 文档

| | |
| --- | --- |
| [快速部署](https://qflarebot.github.io/deploy) | Fork、引导工作流、绑域名、配置 QQ 开放平台 |
| [升级与运维](https://qflarebot.github.io/maintenance) | 同步上游、回滚、换密钥、看构建日志 |
| [插件市场](https://qflarebot.github.io/market) | 已登记的插件，一键装到你的机器人 |
| [插件开发指南](https://qflarebot.github.io/plugin-guide) | 从零写一个插件 |
| [参与开发](https://qflarebot.github.io/development) | 本地开发框架本身 |

## 状态

早期版本（0.x）。自部署链路已在线上验证，但目前只在**个人使用**的场景下测过：一个人部署、机器人进自己的群。各版本的改动见 [Releases](https://github.com/QFlareBot/QFlareBot/releases)。

## 参与贡献

- **问题与建议**：提 [Issue](https://github.com/QFlareBot/QFlareBot/issues)，按模板填上出错的步骤和日志，密钥记得打码。
- **提 PR**：Fork 后从 `main` 拉分支，改完先在本地跑 `pnpm build && pnpm -r typecheck && pnpm test`，再向 `main` 提 PR。CI 会跑同样的检查，外加种子应用投影和部署配置的 dry-run。环境搭建见[参与开发](https://qflarebot.github.io/development)。
- **保持向后兼容**：已部署的机器人靠同步上游升级，中间不会有人手动迁移。改管理接口、D1 表结构、构建脚本时，要让旧部署同步之后直接能跑：接口只加字段不删改，表结构只增不改，新旧构建脚本与 Worker 互相认得。
- **提交信息**：`类型(范围): 说明`，例如 `feat(bootstrap): …`、`fix: …`、`docs: …`。
- **写插件不用往这里提 PR**：插件放在你自己的仓库，到 [QFlareBot/plugins](https://github.com/QFlareBot/plugins) 登记就能出现在插件市场，见[发布插件](https://qflarebot.github.io/publish)。
- **改文档**：文档在 `docs/`，文档站每页底部都有「在 GitHub 上编辑此页」。

贡献的代码按所在目录的协议发布，见下一节。

## 协议

[GPL-3.0-or-later](LICENSE)。`packages/sdk`、`packages/ui-bridge`、`templates/plugin` 与 `plugins/` 采用 MIT。
