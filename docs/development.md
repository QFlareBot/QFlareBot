# 参与开发

需要 Node ≥ 22 与 pnpm 10。

```bash
git clone https://github.com/QFlareBot/QFlareBot
cd QFlareBot
pnpm install
pnpm test
cp apps/seed/.dev.vars.example apps/seed/.dev.vars   # 填写 BOT_APPID / BOT_SECRET / ADMIN_TOKEN
pnpm dev                                             # 打开 http://localhost:8787
```

## 目录

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
| `docs/` | 本文档站（VitePress） |

## 文档站

`docs/` 的依赖独立于 workspace，Workers Builds 装依赖时不会带上 VitePress。安装时必须带 `--ignore-workspace`，否则会写进根目录的 lockfile：

```bash
cd docs
pnpm install --ignore-workspace
pnpm dev
```

推到 main 后由 Actions 构建并发布到 <https://qflarebot.github.io>。

## 提交

问题与建议请提 [Issue](https://github.com/QFlareBot/QFlareBot/issues)。提交 PR 前请确保 `pnpm build && pnpm -r typecheck && pnpm test` 通过。
