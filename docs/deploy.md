# 快速部署

把 Worker 部署上去只是第一步，机器人要能收发消息还得走完下面四步。第一步跟着网页向导走就行；后面几步要分别到 Cloudflare 和 QQ 开放平台的后台操作。

::: tip
目前只在**个人使用**的场景下验证过：一个人部署、机器人进自己的群。
:::

## 准备

开始前先办好这两件事，免得跑到一半卡住：

- **登录 Cloudflare**：先在浏览器里登录好（免费版账号即可）。向导会带你打开 Cloudflare 后台创建 token、连接仓库，没登录的话每一步都要先登录。
- **一个托管在 Cloudflare 上的自己的域名**：QQ 开放平台访问不到 `*.workers.dev`，回调必须走你自己的域名。没有的话可以找个免费的二级域名接入 Cloudflare，见[绑定自定义域名](./deploy-domain#准备域名)。

其余的：

- **GitHub 账号**：用来 Fork 仓库、运行引导工作流。
- **R2（可选）**：想让插件用 R2 存文件的话，先在 Cloudflare 后台激活一次（免费额度内不扣费）；不激活也能部署，只是不绑 R2。
- **QQ 机器人**：不用提前准备。部署完在面板「设置」里用手机 QQ 扫码新建一个，已有的话填入它的 AppID 与 AppSecret。

## 1. Fork 并运行引导工作流

1. Fork [QFlareBot 仓库](https://github.com/QFlareBot/QFlareBot)。
2. 打开你 Fork 出来的仓库，进入 **Actions** 页。GitHub 默认不在 Fork 里运行工作流，第一次进去会看到提示，点 **I understand my workflows, go ahead and enable them** 启用。
3. 在左侧选 **Bootstrap**，点右边的 **Run workflow**，参数保持默认，再点绿色的 **Run workflow** 按钮。
4. 刷新页面，点进新出现的这次运行，再点 **bootstrap** 任务，展开 **网页引导（Quick Tunnel 向导）** 这一步看实时日志。等一两分钟，日志里会出现这样一行：

   ```
   🚀 引导向导已就绪：https://xxxx.trycloudflare.com/?sid=...
   ```

   这就是向导网址。运行页的 Summary 要等这一步结束才显示，所以运行过程中只能从日志里找。

::: warning 拿到网址后尽快打开
网址里带一次性鉴权：**第一个打开它的浏览器会独占向导**，之后别人再打开只会看到“向导已被接管并锁定”。公开仓库的 Actions 日志谁都能看，所以拿到网址就马上打开。

如果你打开时看到“向导已被接管并锁定”，或者你还没打开，日志里就出现了“向导已被首个浏览器会话成功认领并锁定”，说明被别人抢先了：立刻在运行页点 **Cancel workflow** 结束这次运行，再重新运行一次 Bootstrap，会生成新的网址。
:::

打开网址时如果显示无法访问，稍等一会儿再刷新：临时隧道的地址刚生成时经常还没生效，一般过一会儿就能打开。15 分钟内没有人打开的话，工作流会自动结束，重新运行即可。

5. 跟着向导走：创建预填好权限的 Cloudflare API token、设置面板登录密钥 `ADMIN_TOKEN`，然后部署，最后连接仓库。QQ 机器人不在这里填，第 3 步再建。

向导的完成页会给出一个 `https://qqbot.<你的子域>.workers.dev` 的面板地址，可以先用它登录面板看看；但**不要把它当成回调地址**，下一步要换成自己的域名。

这个地址和你的账户信息只显示在向导页面上。公开仓库的 Actions 日志和运行页 Summary 谁都能看，所以那里不写地址、账户 ID 和资源 ID，日志里出现的会被打成 `***`。之后想再找面板地址，到 Cloudflare 后台 Worker 的 **Settings → Domains & Routes** 里看。

`ADMIN_TOKEN` 只有你知道，引导不会在任何地方输出它，记好。Token 权限清单、无 UI 模式、手动部署与自部署原理见仓库里的 [apps/seed/README.md](https://github.com/QFlareBot/QFlareBot/blob/main/apps/seed/README.md)。

## 2. 绑定自定义域名

在 Cloudflare 后台给 Worker 加一个 Custom Domain，比如 `bot.example.com`。详见[绑定自定义域名](./deploy-domain)。

## 3. 创建机器人并配置 QQ 开放平台

用自定义域名打开面板，在「设置」里扫码新建 QQ 机器人，或填入已有机器人的 AppID 与 AppSecret。然后到 QQ 开放平台填写回调地址 `https://bot.example.com/webhook` 并勾选事件；校验通过后，把机器人拉进你是群主的群，按需在群里打开权限。详见[配置 QQ 开放平台](./deploy-qq)。

## 4. 试一下

在群里 @机器人 发 `/echo 你好`（`echo` 是默认开启的内置插件），机器人应该回复“你好”。

同时打开面板（用自定义域名），概览页的「最近事件」里应该能看到这条消息。收不到的话见[配置 QQ 开放平台 · 常见问题](./deploy-qq#常见问题)。

## 遇到别的问题

上面没提到的问题，请到 GitHub [提交 Issue](https://github.com/QFlareBot/QFlareBot/issues)，附上出错的步骤和日志截图或报错文字。
