# 种子应用

这是最终部署到 Cloudflare 的 Worker。它不包含框架代码，只声明"用哪个运行时、装哪些插件"。

## 两种入口

- `src/index.ts`：静态入口，直接 import 工作区插件，供 `wrangler dev` 与快速部署。
- `dist/index.js`：由清单投影生成（本地 `pnpm project`，或构建机上的 `manifest:prepare`），用 `wrangler.generated.jsonc` 或自部署脚本部署。

## 首次部署：引导工作流（推荐）

仓库根目录的 [`.github/workflows/bootstrap.yml`](../.github/workflows/bootstrap.yml) 会把资源创建、
部署、密钥写入一次做完。**幂等可重跑、零 Git 污染**：资源按名字复用，全程不向你的 fork 产生任何提交。

1. Fork 本仓库。
2. 运行 **Bootstrap** 工作流（Actions → Bootstrap → Run workflow），两种模式自动选择：
   - **网页引导**（什么都没配时）：工作流起一个临时网页（Quick Tunnel），点开 run 页 Summary
     里的链接，跟着网页走——网页会给出**权限预填的** token 创建链接，粘贴 token 即时校验
     （缺哪个权限当场点名），然后建资源、看进度、连接仓库、创建构建 token。
   - **无 UI 引导**（配了 secret `CLOUDFLARE_API_TOKEN` 与 `ADMIN_TOKEN` 时）：直接跑完，汇总写进
     run 页 Summary。`ADMIN_TOKEN` 必须自己定（它就是面板登录密钥，只有你知道明文）；缺任一个
     secret 会直接失败并在日志里给出配置指引。
3. 工作流结束后照 Summary 里的清单收尾：绑定自定义域名、QQ 开放平台填回调地址、连接仓库（网页向导里已做完）。

**自定义域名必须绑，由你自己选、自己绑。** QQ 开放平台访问不到 `*.workers.dev`（已实测，回调验证不通过），
所以回调必须走你自己的域名。引导只部署到默认的 `<Worker名>.<子域>.workers.dev`（面板与构建机拉清单用它），
不接收也不绑定自定义域名，也不给出 workers.dev 的回调地址。部署完到 Cloudflare 后台 Worker → Settings →
Domains & Routes 的 Custom Domains 添加一个（域名要托管在同一个 Cloudflare 账户下），回调地址填
`https://你的域名/webhook`——用新域名打开面板，概览页可以一键复制。之后的部署（重跑引导、自部署构建）都不会改动你绑的域名。

Token 权限清单（预填链接已带；手动创建照此勾选）：

| 权限组 | 级别 |
| --- | --- |
| Workers Scripts | Edit |
| Workers KV Storage | Edit |
| D1 | Edit |
| Workers R2 Storage | Edit |
| Account Settings | Read |
| Workers 构建配置（Workers Builds Configuration，也可能显示为 Workers CI） | Edit（网页向导用：自动检测仓库连接、写构建配置、补跑首次构建；无 UI 模式用不到） |
| 账户范围 | 所有账户（或包含目标账户） |

> 引导只做**只读探测**（GET 一个列表端点）：通过只说明读权限够用，Edit 缺失要到真正部署时才报 403。
> 用上面的预填链接创建 token 可以避开这个盲区；手动创建时请照表逐项勾选。

引导做了什么（无 UI 模式的完整清单）：

- 验证 token 与权限；单账户自动推导账户 ID（多账户要求填 `account_id` 输入）
- **幂等创建/复用**同名 KV / D1 / R2（名字可在 workflow 输入里改；R2 未激活时自动降级为
  不绑定，只在后台激活 R2 后重跑即可）
- 读取 D1 里已安装的插件，与内置清单一起构建 + `wrangler deploy`——重跑引导不会把面板里装的插件
  从线上抹掉
- 资源 id、Worker 名**不进 Git**：经 `wrangler secret bulk` 写入 Worker Secrets，
  并通过 `GET /admin/build-config` 构建端点动态下发给构建机（K/V、D1 必须有 id：自部署走的
  Versions API 不认名字，缺 id 报 10021）
- 写入 Worker 密钥：`ADMIN_TOKEN`（**必须自己设置**，至少 12 个字符：无 UI 模式取自你的 GitHub
  secret，网页向导模式在表单里填。引导不代为生成，也不在任何地方回显——公开仓库的日志与 Summary
  谁都能看，生成出来的密码没有安全的途径交到你手上）、`CF_ACCOUNT_ID`、`CF_WORKER_NAME`、`CF_KV_ID`、`CF_D1_ID`、
  `CF_R2_NAME`、`CF_DEFAULT_DOMAIN`，配了 `CLOUDFLARE_BUILDS_TOKEN`
  secret 时再写 `CF_BUILDS_TOKEN`
- QQ 凭证：无 UI 模式配了 secrets `QQ_APPID`/`QQ_APP_SECRET`、或网页向导表单里填了的话，部署后
  调 `PUT /admin/bot` 存进 KV（先向 QQ 验证，与管理面板同一条路径）。还没有机器人时，向导表单和
  面板设置页都能**扫码创建**：手机 QQ 扫码确认即新建一个机器人，AppID/AppSecret 自动带入（协议同 AstrBot）。
  回调地址扫码给不了，仍要到 QQ 开放平台手填一次

> R2 在新账户上需要先到后台激活一次（免费额度内不扣费），API 替代不了；向导会在前置检查里提醒。

### 手动首次部署（不用工作流）

```bash
pnpm install && pnpm build
wrangler login                                  # OAuth，免建 API token
# 手工把 KV / D1 创建出来并把 id 填进 wrangler.jsonc（或依赖 wrangler deploy 的自动预配）
wrangler secret put ADMIN_TOKEN                 # 随机长字符串
pnpm --filter @qqbot/seed run deploy
```

不接触线上环境就想确认部署配置没问题时，先投影再 dry-run（免凭证）：

```bash
pnpm --filter @qqbot/seed run project
pnpm --filter @qqbot/seed run deploy:check      # = wrangler deploy --dry-run，CI 也跑这一步
```

## 插件以源码分发

- 框架版本（core/ui）与**内置插件**在仓库的 `qqbot.manifest.json`，git 管理：diff、回滚、审查都免费。
- **已安装插件集存在 D1**（`rt_manifest_plugins`），由面板/管理 API 增删；每次安装/卸载/构建都记录在 `rt_installs` 账本（清单哈希、build_uuid、commit、状态）。
- 两份清单在构建时合并，D1 同名覆盖内置插件。

## 自部署：Worker 触发 Workers Builds

装/卸插件需要重新编译，而 Worker 里没有编译器。所以流程是：**Worker 改 D1 清单 → 调 Builds REST API
触发一次构建 → 构建机拉源码编译并部署**。设置步骤：

1. 仓库推到 GitHub，在 Cloudflare Dashboard 的 Worker → Settings → Builds 里连接仓库（引导工作流会给出直达链接）。
2. **构建命令与环境变量不用手填。** 仓库一连上，这四项就会经 Builds API 自动写进 trigger：

   | 项 | 值 |
   | --- | --- |
   | Build command | `pnpm build && pnpm --filter @qqbot/seed run manifest:prepare` |
   | Deploy command | `pnpm --filter @qqbot/seed run manifest:deploy` |
   | 环境变量 `MANIFEST_URL` | `https://<默认域名>/admin/build-manifest` |
   | 环境变量 `MANIFEST_TOKEN` | Worker 侧 `BUILD_TOKEN` 的同值（引导自动生成） |

   写入时机有两处：**网页向导**在你连完仓库、点「完成引导」时写；**无 UI 引导**跑的时候 trigger
   还不存在（仓库尚未连接），改由 Worker 在第一次触发构建、自发现到 trigger 时补写。
   只写一次，之后你在后台的手动调整不会被覆盖回去。

3. 可选的构建环境变量：

   | 变量 | 说明 |
   | --- | --- |
   | `MANIFEST_FALLBACK` | 默认不设。**只在应急时**设成 `1`：允许清单拉取失败后回退到仓库内置清单 |
   | `CF_WORKERS_DEV` | 设 `0` 关掉 workers.dev。绑了自定义域名之后没必要继续把面板与 `/webhook` 暴露在默认域名上；版本预览地址由 `preview_urls` 单独控制，与它无关 |

   > **清单拉不到 = 构建失败**（除非上面那个 `MANIFEST_FALLBACK=1`）。这是故意的：继续构建只会打包
   > 仓库内置清单，D1 里装的插件会从 Worker 上消失（数据还在 D1，插件不跑了），而构建却报成功——
   > 这是最难查的一类故障。
   >
   > 唯一的例外是**本次部署本来就没有绑 D1**：那时清单端点返回 503 是预期的，构建机读
   > `/admin/build-config` 的 `hasD1`（由 Worker 侧的 `!!env.DB` 如实回答）自行判断并继续。
   > 注意判据是 `hasD1` 而不是 `d1Id`——后者来自 `CF_D1_ID` secret，「secret 没写但 D1 确实绑着」
   > 会被误判成「没有 D1」，于是面板一抖动就静默把 D1 里装的插件从 Worker 上抹掉。
   > 所以别为了绕过报错去设 `MANIFEST_FALLBACK`——先看清楚是「面板连不上」还是「真的没有 D1」。

4. 给 Worker 配置触发构建用的凭证（`wrangler secret put`，引导工作流会自动写入）：

   | 变量 | 说明 |
   | --- | --- |
   | `CF_ACCOUNT_ID` | Cloudflare 账号 ID |
   | `CF_BUILDS_TOKEN` | **user-scoped** API token（Builds API 不接受 account-scoped），权限：Workers Builds Configuration (Edit) + Workers Scripts (Read) |
   | `CF_WORKER_TAG` / `CF_TRIGGER_UUID` | **可选**。省略时运行时按 `vars.WORKER_NAME` 自发现并缓存进 KV（要求仓库已连接 Workers Builds；重连仓库导致缓存失效会自动重发现）。想写死也可以：tag 是 `GET /accounts/{account_id}/workers/scripts` 返回的 `tag` 字段（`id` 是名字，别拿错），trigger UUID 来自 `GET /accounts/{account_id}/builds/workers/{tag}/triggers` |
   | `CF_BUILD_BRANCH` | 可选，默认 `main` |
   | `BUILD_TOKEN` | 构建机拉清单的专用令牌，引导首次自动生成并写入，**重跑沿用 Worker 上已有的值、不轮换**（trigger 里那份不会跟着变，换了构建就 401）——**Worker 侧叫 `BUILD_TOKEN`，构建机侧叫 `MANIFEST_TOKEN`，是同一个值**。两边的对齐由引导代劳（自动写 trigger 环境变量），不用自己搬。想换值：`wrangler secret put BUILD_TOKEN` 后同步改构建环境变量，或重跑无 UI 引导时配 `BUILD_TOKEN` secret |

   `vars.WORKER_NAME` 在 `wrangler.jsonc` 里（引导工作流按 Worker 名同步维护），自发现靠它定位自己。

流程与安全阀：

- `POST /admin/builds` 用 `{"branch":"main"}` 触发构建（构建分支当前状态，无需自己解析最新 commit），返回 `buildUuid` 记入账本；`GET /admin/builds` 轮询状态并回填 commit，Cron 每分钟也会检查一次（账本里没有进行中的记录时不产生任何请求）。
- **声明了 Durable Object 的插件在安装这一步就被拦下。** DO 的 `migrations` 是只追加的历史，平台靠「上次应用过的 tag」算增量，构建机没有这个持久状态、造不出来，所以投影只校验不合成。校验发生在构建阶段——不拦的话插件已经写进 D1 才炸，而且是**每一次**构建都炸（包括之后装别的插件），直到有人想到卸载它。运行时读不到仓库里的 `wrangler.jsonc`，判断不了那条 migrations 加没加，所以把要加的内容原样给出，由用户确认后重装。
- `deploy` 阶段直接用构建产物走 Versions API：上传版本 → 预览地址 `/healthz` 健康检查 → 切 100% 流量，健康检查失败不切（含 Durable Object 的 Worker 无预览 URL，平台限制下跳过）。
- 部署目标取 `wrangler.generated.jsonc` 的 `name`，不是模板的——`CF_WORKER_NAME` 只在 `prepare` 进程里被 `/admin/build-config` 注入，而构建机的 build 与 deploy 是两条独立命令、两个进程。
- 绑定没解析出来（`dist/projection.json` 的 `bindings` 里有 `unresolved`）一律拒绝部署。判据是投影记下的解析状态而不是元数据里的占位符：D1/R2 没解析出来时是**整个绑定不出现**，扫占位符只拦得住 KV。Worker 如实回答没绑的资源（`/admin/build-config` 的 `hasD1` / `hasR2` 为假，比如 R2 未激活被降级）按显式跳过（`CF_*=none`）处理，不算没解析出来。
- 降级到 `wrangler deploy` 时会打一段醒目警告并列出本次会同步的脚本级设置（routes / workers_dev / crons）——Versions API 不碰这些，wrangler 会按配置改。自定义域名例外：模板与生成配置都不声明 routes，wrangler 在这种情况下完全不碰域名（一旦声明，它会按配置**整体替换**，后台另绑的会被摘掉）。
- 构建机拉不到构建清单时**硬失败**（见上文），只有「这次部署确实没有 D1」（`/admin/build-config` 的 `hasD1` 为假）或显式 `MANIFEST_FALLBACK=1` 才会回退到仓库内置清单。
- 回滚三选一：Cloudflare 后台版本回滚；D1 恢复清单快照 + 重新触发构建；git revert 内置清单 + 重建。

## 管理端点（自部署相关）

| 端点 | 说明 |
| --- | --- |
| `GET /admin/build-manifest` | 构建机拉取插件清单 `{ hash, plugins, pendingBuild }`；`BUILD_TOKEN` 优先，未配置走管理鉴权。`pendingBuild` 是触发这次构建的账本记录，构建机据此对照「触发时」与「实际构建」的清单哈希，不一致只告警 |
| `POST /admin/manifest/plugins` | 安装/升级 `{ source: "git:owner/repo@sha[#子目录]" }`**并就地触发一次重建**；校验声明清单、撞名、conflicts、depends。插件声明了 Durable Object 时返回 409 `durable_objects_migration_required` 并给出要往 `wrangler.jsonc` 补的 migrations（见下），补完后带 `acknowledgeDurableObjects: true` 重新安装 |
| `DELETE /admin/manifest/plugins/:name[?purge=true]` | 卸载（移出 D1 清单）**并就地触发一次重建**；响应里的 `build` 是 `{ buildUuid }` 或 `{ error }`——触发失败不回滚卸载，需要手动重试构建。`purge=true` 连插件数据一起清，默认保留 |
| `POST /admin/builds` | 触发构建，返回 `buildUuid` |
| `GET /admin/builds` | 安装/构建账本，顺带同步进行中构建的状态与 commit。Cron 也会自动同步（有进行中记录时最快 3 分钟一次），所以装完插件关掉页面账本照样会收敛 |
| `GET /admin/storage` | 各插件占用的 KV 键数 / D1 表与行数 / R2 对象数与字节数，以及不属于任何已装插件的孤儿数据 |
| `DELETE /admin/storage/orphans/:name` | 清掉某个已卸载插件的残留数据（对还装着的插件返回 409） |

面板 → 插件页可以直接粘贴仓库链接安装（自动解析最新 commit）并查看构建记录；以上端点也可用 curl / 任意客户端调用。

## 本地清单格式

`qqbot.manifest.json` 是 `DeployManifest`：`core.version` 指运行时版本；每个插件的 `source` 支持 `file:`（相对本文件）、`git:<owner>/<repo>@<commit>[#子目录]`（源码构建，推荐）；旧模型兼容 `npm:<pkg>`、`github:<owner>/<repo>`（Release 制品）、`url:<https://…>`。`manifest` 可以是内联对象，也可以是 `file:` 指向构建产物的 `manifest.json`。

`git:` 来源要求插件仓库提交声明清单（根目录 `manifest.json`，`qqbot-plugin build` 生成）：安装前安装器读它做校验与展示，构建时重新抽取并与它比对，不一致即构建失败。
