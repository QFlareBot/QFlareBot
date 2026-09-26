# QFlareBot

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

早期版本（0.1）。自部署链路已在线上验证，但目前只在**个人使用**的场景下测过：一个人部署、机器人进自己的群。问题与建议请提 [Issue](https://github.com/QFlareBot/QFlareBot/issues)。

## 协议

[GPL-3.0-or-later](LICENSE)。`packages/sdk`、`packages/ui-bridge`、`templates/plugin` 与 `plugins/` 采用 MIT。
