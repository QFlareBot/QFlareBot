# 快速部署

把 Worker 部署上去只是第一步，机器人要能收发消息还得走完下面四步。前一步只要几分钟；后面几步要分别到 Cloudflare 和 QQ 开放平台的后台操作。

## 准备

- **GitHub 账号**：用来 Fork 仓库、运行引导工作流。
- **Cloudflare 账号**：免费版即可。想让插件用 R2 存文件的话，先在 Cloudflare 后台激活一次 R2（免费额度内不扣费）；不激活也能部署，只是不绑 R2。
- **一个托管在 Cloudflare 上的域名**：QQ 开放平台访问不到 `*.workers.dev`，回调必须走你自己的域名。还没有的话见[绑定自定义域名](./deploy-domain#准备域名)。
- **QQ 机器人**：已有的话准备好 AppID 与 AppSecret；没有也行，引导向导和面板都能用手机 QQ 扫码新建一个。

## 1. Fork 并运行引导

1. Fork [QFlareBot 仓库](https://github.com/QFlareBot/QFlareBot)。
2. 在你的 Fork 里运行 **Actions → Bootstrap → Run workflow**，打开运行摘要（Summary）里的向导链接。
3. 跟着向导走：创建预填好权限的 Cloudflare API token、设置面板登录密钥 `ADMIN_TOKEN`、填写 QQ 机器人凭证（或扫码新建），最后连接仓库。

向导结束时会给出一个 `https://qqbot.<你的子域>.workers.dev` 的面板地址，可以先用它登录面板看看；但**不要把它当成回调地址**，下一步要换成自己的域名。

`ADMIN_TOKEN` 只有你知道，引导不会在任何地方输出它，记好。Token 权限清单、无 UI 模式、手动部署与自部署原理见仓库里的 [apps/seed/README.md](https://github.com/QFlareBot/QFlareBot/blob/main/apps/seed/README.md)。

## 2. 绑定自定义域名

在 Cloudflare 后台给 Worker 加一个 Custom Domain，比如 `bot.example.com`。详见[绑定自定义域名](./deploy-domain)。

## 3. 配置 QQ 开放平台

到 QQ 开放平台填写回调地址 `https://bot.example.com/webhook`，勾选事件，把测试群加进沙箱。详见[配置 QQ 开放平台](./deploy-qq)。

## 4. 试一下

在沙箱里的测试群 @机器人 发 `/echo 你好`（`echo` 是默认开启的内置插件），机器人应该回复“你好”。

同时打开面板（用自定义域名），概览页的「最近事件」里应该能看到这条消息。收不到的话见[配置 QQ 开放平台 · 常见问题](./deploy-qq#常见问题)。
