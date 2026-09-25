# 快速部署

1. Fork [QFlareBot 仓库](https://github.com/QFlareBot/QFlareBot)。
2. 运行 **Actions → Bootstrap → Run workflow**，打开运行摘要里的向导链接，按提示填写 Cloudflare API token 与 QQ 机器人凭证。
3. 在 Cloudflare 后台为 Worker 绑定自定义域名（QQ 开放平台无法访问 `*.workers.dev`）。
4. 在 QQ 开放平台把回调地址设为 `https://<你的域名>/webhook`。

Token 权限、无 UI 模式、手动部署与自部署原理见仓库里的 [apps/seed/README.md](https://github.com/QFlareBot/QFlareBot/blob/main/apps/seed/README.md)。
