# 绑定自定义域名

QQ 开放平台访问不到 `*.workers.dev`（实测回调地址校验不通过），所以回调必须走你自己的域名。引导不会替你选域名，也不会替你绑：域名由你在 Cloudflare 后台自己加，之后重跑引导或自部署构建都不会改动它。

## 准备域名

域名必须托管在**部署机器人的同一个 Cloudflare 账户**下。

- **已经在 Cloudflare 上**：直接看下一节。
- **还没有域名**：在任意注册商买一个（Cloudflare 自己的注册商也行，按成本价卖）。
- **域名在别的服务商那里解析**：在 Cloudflare 后台点 **Add a domain**（添加域名），按提示到注册商那里把域名的 NS 服务器改成 Cloudflare 给的两个。等域名状态变成 **Active** 再继续，通常几分钟到几小时。

建议用一个子域名（如 `bot.example.com`）专门给机器人，别占用主站。

## 绑定到 Worker

<!-- 截图：Worker → Settings → Domains & Routes → Add → Custom domain 的对话框 -->

1. 打开 Cloudflare 后台，进入 **Workers & Pages**（计算），点你的 Worker（默认叫 `qqbot`）。
2. 切到 **Settings** 标签页，找到 **Domains & Routes**，点 **Add**，选 **Custom domain**。
3. 输入域名，如 `bot.example.com`，点 **Add domain**。

Cloudflare 会自动创建 DNS 记录并签发 HTTPS 证书，一般几分钟就好。要是提示这个名字已经有 DNS 记录，先到域名的 DNS 页面删掉那条旧记录再试。

## 确认

用浏览器打开 `https://bot.example.com/`，能看到面板登录页就说明绑好了。用 `ADMIN_TOKEN` 登录，概览页的「回调地址」卡片会显示 `https://bot.example.com/webhook`，下一步把它填到 QQ 开放平台。

## 注意

- **不要关掉 workers.dev**。Worker 的 Domains & Routes 里那条 `*.workers.dev` 路由要留着：构建机装插件、更新插件时从这个地址拉插件清单，关掉以后构建会失败。
- QQ 开放平台只允许回调地址用 80 / 443 / 8080 / 8443 端口。Custom Domain 走的是 443，不用额外设置。

下一步：[配置 QQ 开放平台](./deploy-qq)。
