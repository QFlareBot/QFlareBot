# 种子应用

这是最终部署到 Cloudflare 的 Worker。它不包含框架代码，只声明"用哪个运行时、装哪些插件"。

## 两种入口

- `src/index.ts`：静态入口，直接 import 工作区插件，供 `wrangler dev` 与快速部署。
- `dist/index.js`：由 `qqbot.manifest.json` 投影生成（`pnpm project`），与线上自我部署产出的 bundle 形状一致，用 `wrangler.generated.jsonc` 部署。

## 首次部署

```bash
wrangler secret put BOT_APPID
wrangler secret put BOT_SECRET
wrangler secret put ADMIN_TOKEN
pnpm deploy            # 或 pnpm deploy:projected
```

`wrangler.jsonc` 里的 KV / D1 / R2 只写名字，wrangler 会自动创建缺失资源、复用同名资源。**不要在 Cloudflare 后台手工加绑定**，以配置文件为准才不会在下次部署时丢失。

部署后到 QQ 开放平台把回调地址填成 `https://<域名>/webhook`。大陆网络访问 `*.workers.dev` 不稳定，生产环境请在 `wrangler.jsonc` 里配置自定义域名。

## 本地清单格式

`qqbot.manifest.json` 是 `DeployManifest`：`core.version` 指运行时版本；每个插件的 `source` 支持 `file:`（相对本文件）、`npm:<pkg>`、`github:<owner>/<repo>`、`url:<https://…>`；`manifest` 可以是内联对象，也可以是 `file:` 指向构建产物的 `manifest.json`。
