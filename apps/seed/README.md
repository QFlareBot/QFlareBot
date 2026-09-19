# 种子应用

这是最终部署到 Cloudflare 的 Worker。它不包含框架代码，只声明"用哪个运行时、装哪些插件"。

## 两种入口

- `src/index.ts`：静态入口，直接 import 工作区插件，供 `wrangler dev` 与快速部署。
- `dist/index.js`：由清单投影生成（本地 `pnpm project`，或构建机上的 `manifest:prepare`），用 `wrangler.generated.jsonc` 或自部署脚本部署。

## 首次部署

```bash
wrangler secret put BOT_APPID
wrangler secret put BOT_SECRET
wrangler secret put ADMIN_TOKEN
pnpm deploy            # 或 pnpm deploy:projected / pnpm deploy:manifest
```

`wrangler.jsonc` 里的 KV / D1 / R2 只写名字，wrangler 会自动创建缺失资源、复用同名资源。**不要在 Cloudflare 后台手工加绑定**，以配置文件为准才不会在下次部署时丢失。

部署后到 QQ 开放平台把回调地址填成 `https://<域名>/webhook`。大陆网络访问 `*.workers.dev` 不稳定，生产环境请在 `wrangler.jsonc` 里配置自定义域名。

## 插件以源码分发

- 框架版本（core/ui）与**内置插件**在仓库的 `qqbot.manifest.json`，git 管理：diff、回滚、审查都免费。
- **已安装插件集存在 D1**（`rt_manifest_plugins`），由面板/管理 API 增删；每次安装/卸载/构建都记录在 `rt_installs` 账本（清单哈希、build_uuid、commit、状态）。
- 两份清单在构建时合并，D1 同名覆盖内置插件。

## 自部署：Worker 触发 Workers Builds

装/卸插件需要重新编译，而 Worker 里没有编译器。所以流程是：**Worker 改 D1 清单 → 调 Builds REST API 触发一次构建 → 构建机拉源码编译并部署**。设置步骤：

1. 仓库推到 GitHub，在 Cloudflare Dashboard 的 Worker → Settings → Builds 里连接仓库。
2. 构建命令与部署命令：

   | 项 | 值 |
   | --- | --- |
   | Build command | `pnpm build && pnpm --filter @qqbot/seed run manifest:prepare` |
   | Deploy command | `pnpm --filter @qqbot/seed run manifest:deploy` |
   | Branch | `main`（或你的默认分支） |

3. 给 trigger 配置环境变量（Settings → Builds → Environment variables）：

   | 变量 | 说明 |
   | --- | --- |
   | `MANIFEST_URL` | `https://<你的域名>/admin/build-manifest` |
   | `MANIFEST_TOKEN` | 可选。配了则用专用令牌拉清单；不配则该端点用 `ADMIN_TOKEN` 鉴权 |

4. 给 Worker 配置触发构建用的凭证（`wrangler secret put`）：

   | 变量 | 说明 |
   | --- | --- |
   | `CF_ACCOUNT_ID` | Cloudflare 账号 ID |
   | `CF_BUILDS_TOKEN` | **user-scoped** API token（Builds API 不接受 account-scoped），权限：Workers Builds Configuration (Edit) + Workers Scripts (Read) |
   | `CF_WORKER_TAG` | Worker 的 tag：`GET /accounts/{account_id}/workers/scripts` 返回的 `id`（不是名字） |
   | `CF_TRIGGER_UUID` | `GET /accounts/{account_id}/builds/workers/{tag}/triggers` 返回的 `trigger_uuid` |
   | `CF_BUILD_BRANCH` | 可选，默认 `main` |
   | `BUILD_TOKEN` | 可选，同上第 3 步的 `MANIFEST_TOKEN` |

流程与安全阀：

- `POST /admin/builds` 用 `{"branch":"main"}` 触发构建（构建分支当前状态，无需自己解析最新 commit），返回 `buildUuid` 记入账本；`GET /admin/builds` 轮询状态并回填 commit。
- `deploy` 阶段直接用构建产物走 Versions API：上传版本 → 预览地址 `/healthz` 健康检查 → 切 100% 流量，健康检查失败不切（含 Durable Object 的 Worker 无预览 URL，平台限制下跳过）。
- 构建机拉不到构建清单时（Worker 不可达、D1 未绑定），自动回退到仓库内置清单重建。
- 回滚三选一：Cloudflare 后台版本回滚；D1 恢复清单快照 + 重新触发构建；git revert 内置清单 + 重建。

## 管理端点（自部署相关）

| 端点 | 说明 |
| --- | --- |
| `GET /admin/build-manifest` | 构建机拉取插件清单 `{ hash, plugins }`；`BUILD_TOKEN` 优先，未配置走管理鉴权 |
| `POST /admin/manifest/plugins` | 安装/升级 `{ source: "git:owner/repo@sha[#子目录]" }`；校验声明清单、撞名、conflicts、depends |
| `DELETE /admin/manifest/plugins/:name` | 卸载（移出 D1 清单） |
| `POST /admin/builds` | 触发构建，返回 `buildUuid` |
| `GET /admin/builds` | 安装/构建账本，顺带同步进行中构建的状态与 commit |

面板 → 插件页可以直接粘贴仓库链接安装（自动解析最新 commit）并查看构建记录；以上端点也可用 curl / 任意客户端调用。

## 本地清单格式

`qqbot.manifest.json` 是 `DeployManifest`：`core.version` 指运行时版本；每个插件的 `source` 支持 `file:`（相对本文件）、`git:<owner>/<repo>@<commit>[#子目录]`（源码构建，推荐）；旧模型兼容 `npm:<pkg>`、`github:<owner>/<repo>`（Release 制品）、`url:<https://…>`。`manifest` 可以是内联对象，也可以是 `file:` 指向构建产物的 `manifest.json`。

`git:` 来源要求插件仓库提交声明清单（根目录 `manifest.json`，`qqbot-plugin build` 生成）：安装前安装器读它做校验与展示，构建时重新抽取并与它比对，不一致即构建失败。
