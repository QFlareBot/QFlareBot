# 参与开发

需要 Node ≥ 22 与 pnpm 10。

```bash
git clone https://github.com/QFlareBot/QFlareBot
cd QFlareBot
pnpm install
pnpm build                                           # 包之间靠 dist/ 互相引用，先构建一次
pnpm test
cp apps/seed/.dev.vars.example apps/seed/.dev.vars   # 至少填 ADMIN_TOKEN
pnpm dev                                             # 打开 http://localhost:8787
```

本地没有 QQ 回调，主要靠面板「调试」页的事件模拟器驱动插件：它不发消息给 QQ，没配机器人也能用。

`.dev.vars` 里的 `BOT_APPID` / `BOT_SECRET` 可以不填，到面板「设置」里保存凭证也行。填了的话它们优先于面板保存的凭证，面板上就不能再切换或扫码新建机器人。线上同理：别把这两个配成 Worker Secret。

## 目录

| 目录 | 说明 |
| --- | --- |
| `packages/sdk` | 插件契约与测试工具 |
| `packages/api` | QQ OpenAPI 客户端 |
| `packages/runtime` | Worker 运行时与管理 API |
| `packages/projector` | 清单投影与部署 |
| `packages/plugin-cli` | 插件构建工具 `qqbot-plugin` |
| `packages/ui`、`packages/ui-bridge` | 管理面板与插件页面桥 |
| `plugins/` | 内置插件，见[内置插件](./builtin-plugins.md) |
| `apps/seed` | 部署到 Cloudflare 的 Worker |
| `scripts/bootstrap` | 首次部署引导 |
| `templates/plugin` | 插件仓库模板 |
| `docs/` | 本文档站（VitePress） |

## 文档站

`docs/` 的依赖独立于 workspace，Workers Builds 装依赖时不会带上 VitePress。安装时必须带 `--ignore-workspace`，否则会写进根目录的 lockfile：

```bash
cd docs
pnpm install --ignore-workspace
pnpm dev
```

推到 main 后由 Actions 构建并发布到 <https://qflarebot.github.io>。

## CI

推到 main 和每个 PR 都会跑 `.github/workflows/ci.yml`：

1. `pnpm build`、`pnpm -r typecheck`、`pnpm test`；
2. 投影种子应用（`pnpm --filter @qqbot/seed run project`），用构建产物真跑一遍 CLI；
3. 自部署准备脚本（`manifest:prepare`）：拉取与合并清单、就地构建插件；
4. `deploy:check`：对生成的部署配置跑 `wrangler deploy --dry-run`，不需要 Cloudflare 凭证。

## 提交

问题与建议请提 [Issue](https://github.com/QFlareBot/QFlareBot/issues)。提交 PR 前请确保 `pnpm build && pnpm -r typecheck && pnpm test` 通过。
