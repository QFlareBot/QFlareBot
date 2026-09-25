# 设计决策记录

这份文档记录框架的核心决策与理由，改动契约前先读它。日期：2026-09-18。

## 1. 为什么是 Cloudflare Workers

QQ 开放平台 Webhook 已不再要求 IP 白名单（在 `qqbot-cfworker` 原型中实测：回调验证、被动回复、连续回复、富媒体、单聊主动消息全部跑通）。Webhook 模式没有长连接、没有心跳，Worker 只在有事件时被唤醒，"永久运行"零成本。

## 2. 语言与工具

TypeScript + wrangler。Workers 是 JS 一等公民，WebCrypto/fetch 原生；Rust/Python 在此 I/O 密集场景无收益且生态不足。零第三方运行时依赖（Hono/zod 都没用），bundle 极小。

## 3. 单 Worker，触发构建自部署

一个 Worker 同时承担 bot 与管理面。装/卸插件不是它自己能完成的动作——Workers 里没有编译器，依赖解析更无从谈起——所以"自我部署"的实现是：**Worker 改写 D1 里的插件清单，然后调用 Cloudflare Builds REST API 触发一次构建**；构建机（Workers Builds）拉取本仓库源码与各插件源码，编译并部署。部署脚本（seed 的 `scripts/build-deploy.mjs deploy`）直接用构建产物走 Versions API：上传版本（不切流量）→ 打预览地址 `/healthz` → 切流量。

安全阀：

1. 部署走"先上传后切流量"，健康检查失败就不切。含 Durable Object 的 Worker 没有版本预览 URL（平台限制），此时跳过健康检查——这是当前最大的例外
2. 插件用动态 `import()`，某个插件求值抛错只影响自己，面板照常可用（声明 Durable Object 的插件例外：类必须静态导出，随主模块求值，求值失败会拖垮整个 Worker）
5. 声明 Durable Object 的插件在**安装**这一步就被拦下并给出要补的 `migrations`——投影对 DO 迁移只校验不合成（构建机没有「上次应用到哪个 tag」的持久状态），校验在构建阶段，不拦的话插件已入 D1 才炸，且此后每次构建都炸
3. 快照里的 `safeMode` 跳过全部插件；Cloudflare 后台版本回滚、以及"恢复 D1 清单快照 + 重新触发构建"是最后手段
4. 部署凭证不进 Worker：Worker 只持有 Builds 触发 token（user-scoped，权限仅触发构建与读构建状态）；编译与部署凭证由构建机持有

代价与信任模型：插件代码与框架同 isolate、同 realm 无沙箱，permissions 声明只是"知情同意"，不是安全边界。这与 NoneBot/Koishi 的"装的插件即可信代码"前提一致，文档中说明并建议 bot 单开一个 Cloudflare 账号。

## 4. 插件：源码分发，清单驱动，构建时编译

Workers 没有可写文件系统，也禁止 `eval`，"下载到本地再 import" 不成立；Worker 内编译则受 CPU/体积限制且要自建依赖解析，同样不成立。因此插件以**源码**分发、在构建机编译：

- **插件是源码仓库**（`git:<owner>/<repo>@<commit>[#<子目录>]`，只支持公开的 GitHub 仓库）。作者运行 `qqbot-plugin build` 生成 `dist/plugin.js` + `dist/manifest.json`，并把 `manifest.json` 作为**声明文件提交进仓库**——面板与安装器只读它（权限展示、撞名/依赖/冲突检测），永不执行插件代码。
- **插件可以带第三方依赖，按插件自己的 lockfile 装**。作者照常写 `dependencies`、提交 `package-lock.json` 或 `pnpm-lock.yaml`；构建机把源码解包在机器人仓库**之外**的临时目录，只装 `dependencies`（`npm ci --omit=dev --ignore-scripts`，pnpm 同理），打进插件自己的 `plugin.js`，各插件各带一份、版本互不影响。要点：
  - **必须有 lockfile**：没有的话同一个 commit 在不同时间会装出不同的代码，而每装一个别的插件都会重建全部插件，这个插件就可能被悄悄换掉，「钉在 commit 上」形同虚设。没有第三方依赖的插件不走安装，与以前完全一样。
  - **在仓库外构建**：只解析得到插件自己声明、自己装的依赖。以前构建机解析的是机器人仓库里装着的包——版本不是作者锁定的那份，换一台机器人就构建不过。
  - **框架包一律用机器人仓库那一份**：`@qqbot/sdk` 经 alias 指向机器人仓库，契约只有一个版本；其他 `@qqbot/*` 不许打进插件（会带进第二份运行时），`qqbot-plugin build` 在解析阶段就拦。
  - **不跑安装脚本、抽清单在去掉凭证的子进程里**：抽清单要在 Node 里执行插件入口，插件和它依赖的顶层代码都会跑，构建机上又有凭证。这不是沙箱（文件系统照样碰得到），信任模型仍是「装的插件——连同它的依赖——就是可信代码」。
  - 依赖必须能在 Workers 里跑（不依赖 Node 内置模块、不用 `eval`）；体积与初始化耗时算在全机器人共享的 CPU / 内存里。
- **安装 / 升级 / 卸载 = 写 D1 清单 + 触发构建**：`POST /admin/manifest/plugins` 校验声明清单（apiVersion、撞名、conflicts、depends、表前缀唯一性）后写入 D1 的 `rt_manifest_plugins`（连声明清单一起存，反向依赖、冲突、DO 类比对都靠它）；`DELETE /admin/manifest/plugins/:name` 做反向操作。**两者都在写完清单后就地触发重建**——只改 D1 不重建的话，插件还留在正在运行的 bundle 里，等于没生效。构建触发失败不回滚清单改动（清单已经改了，回滚只会更乱），如实报出来让用户手动重试。安装/升级/卸载/构建全程记录在 `rt_installs` 账本（清单哈希、build_uuid、commit、状态）。

  一次改好几个（批量更新）时不必每个都构建：每个请求带 `build: false` 只写清单，最后调一次 `POST /admin/builds`。构建机拉的是最新清单，一次就全带上了；账本把触发之前的所有 pending 记录都并进这次构建（不按哈希筛——批量写入时每条存的是写它那一刻的哈希）。反过来，改完之后 D1 已经和线上部署一模一样（撤掉的是还没上线的改动）就不再触发构建。

  安装前的检查分两档：以前就拦的照旧拦（conflicts、表前缀撞车、依赖缺失，依赖也认 D1 里等构建的提供者）；同名换了仓库、覆盖内置插件、命令重名、已装插件声明与它冲突、升级新增权限，这些以前能装、现在照样能装，只作为 `warnings` 返回，面板在预检（`dryRun: true`，什么都不写）时摆出来让人确认。DO 只拦**新增**的类：以前有过的类 migrations 早就在仓库里了。

  账本哈希的语义要说准：构建机是**在构建那一刻**从 `/admin/build-manifest` 拉当前清单并据此重建的，也就是「收敛到最新」，**不是**「必须等于触发时那一份」——否则并发装两个插件就会让第二次构建无故失败。所以它**不阻断构建**：`/admin/build-manifest` 会一并返回触发这次构建的账本记录（`pendingBuild`；构建机带上 `x-build-uuid` 时精确对上，不带时取最近一条进行中的），构建机发现「触发时的哈希」与「实际构建的哈希」不一致时在日志里显著告警，由人决定要不要再触发一次。这样既保留可追溯性，又不把正常并发变成构建失败。

  **期望状态与线上状态分开看**。D1 是期望状态，线上跑的是上一次成功构建的那一份，两者之间总有时间差（构建几分钟，还可能失败）。构建机给每个插件记下出处（D1 装的还是仓库内置的、原始 git 来源），投影进入口模块（不参与投影哈希），运行时据此回答「线上这一份是什么」。`GET /admin/manifest/plugins` 把两边对照：已上线、线上是另一份、根本没上线、卸载还没生效。没有出处信息的老部署照旧能用，只是判断不了「清单是否已与线上一致」。

  **构建失败时线上保持上一次成功的版本**，这是故意的；失败的条目会留在 D1 里，之后每次构建都会带上它、每次都失败，直到有人处理。所以构建机把每个插件都试着编一遍，把「哪个插件、为什么」经 `POST /admin/build-report` 报回来（只写错误信息，不改清单），面板的「未上线的改动」里列出这些条目：从没装上的直接卸载，升级失败的改回线上那一版。
- **清单真相分层**：框架版本（core/ui）与内置插件在仓库的 `qqbot.manifest.json`（git 管，diff/回滚免费）；已安装插件集在 D1（运行时可写、有账本）；两者在构建时合并（D1 同名覆盖内置插件；D1 条目总带着来源，只能替换、下架不了——要下架内置插件改 `qqbot.manifest.json`）。启用/禁用/改配置仍是 KV 快照，不触发构建。
- **构建时校验**：构建机按 commit 拉 tarball、esbuild 就地打包，重新抽取清单并与声明清单比对，不一致即失败——防止声明与代码漂移。产物记 SRI 完整性。
- 旧制品源（`npm:` / GitHub Release 的 `github:` / `url:`）投影器仍支持，属旧模型兼容，不再推荐。
- Dynamic Workers（Worker Loader，付费版 beta）保留为**不可信脚本**场景的执行后端（如群管自定义脚本、LLM 生成代码），制品格式相同，但不是插件系统的基础。

种子仓库的本地投影命令（`pnpm project`）与构建机（`manifest:prepare`）跑同一个投影库，产出一致（投影哈希相同），互不覆盖。

## 5. 插件数据：前缀即所有权

三种存储都按插件名加前缀——KV 是 `p:<名>:`、R2 是 `p/<名>/`、D1 是表名 `p_<名>_`。KV 和 R2 的前缀在包装层拼键时强制，插件拿不到原始 binding；D1 过去只有 `db.table()` 给个建议值，`run/exec` 收裸 SQL，等于零约束。现在 SQL 里必须写 `{表名}` 占位，指向别处的表名一律抛错（`sqlite_master`、引号包名、库名限定、`ATTACH`/`PRAGMA` 都拦）。

**这不是安全边界**，插件和运行时编译进同一个 Worker、同一个 JS realm，真要使坏绕得过去；`permissions` 同样只用于安装前展示。前缀强制要买的是另外两样东西：插件之间不会撞表或误删，以及——**框架凭前缀才枚举得出一个插件建过哪些表**。卸载能把数据清干净，唯一的前提就是这个；表名逃出命名空间的那部分数据，框架永远只能留成孤儿。

「不会撞表或误删」有个必须承认的前提：`tablePrefix` 把非字母数字一律换成 `_`，于是 `my-plugin` 与 `my_plugin` 落到**同一个前缀** `p_my_plugin_`。所以加了两道闸——安装时拒绝与已装插件同前缀的组合（409），卸载时若某张表同时匹配别的已知插件的前缀就跳过不删并回报 `skippedTables`。宁可留一条孤儿，也不能 `DROP` 掉邻居的表：那是不可逆的。

由此：

- **卸载的清理分两步**：先调插件的 `onUninstall(ctx, { purgeData })`（趁它的代码还在这次部署里，重建之后就没机会了），再由框架按前缀兜底清理。钩子抛错不挡兜底——插件写坏了不该让数据永远清不掉。
- **数据默认保留**。卸载多半是不想要了，但误删不可逆。留下的数据在 `GET /admin/storage` 里列为孤儿（名字从 KV/R2 的键前缀反推，D1 的从 `rt_installs` 账本补），可以单独清掉。「默认删」和「管不了」之间的第三条路是「默认留但看得见」。
- **`onInstall` 的 `rt:installed:<名>` 标记无条件删掉**。数据清了，重装必须重新建表；数据留着，`onInstall` 本来就要求幂等。留着标记的后果是重装后它静默不跑。
- **卸载要在新版本上线后再收一次尾**。卸载请求当场删标记、清数据，但重建完成前旧代码还在跑：冷启动的实例读不到标记会重跑 `onInstall`，把表建回来、把标记写回去——正好复现上一条要防的问题。所以卸载时记一条待清理（`rt_pending_cleanups`），等插件确实不在这份部署里了，由 Cron 再删一遍标记、按需再清一遍数据（连快照里的配置）。收尾之前又装回来就取消它。
- **跨插件访问数据走 service，不走数据层**。直读别人的表是隐形依赖：对方一卸载，消费者静默坏掉，框架看不见这层关系。`services` + `depends` 把依赖写进清单，安装时校验，面板上可见。

## 6. 契约稳定性规则

1. **SDK 与 Runtime 分离**：`@qqbot/sdk` 只有类型、`definePlugin`（恒等函数）与测试工具；插件 bundle 中不允许任何运行时 import，所有能力由注入的 `ctx`/`session` 提供。框架升级不要求插件重新打包。
2. **契约有版本**（`apiVersion`）；旧契约的适配器是独立 compat 包，只在清单含旧插件时投影进 bundle。
3. **处理器只接收一个对象参数**，返回值也是对象；加字段永远兼容。
4. **永远暴露原始层**：`session.raw`、`ctx.api.raw()`。QQ 新增能力不必等框架发版。
5. **触发器与配置 schema 是数据**（manifest / JSON Schema），面板与安装器不执行插件代码。
6. **能力优先做成服务**（`services` / `depends` / `ctx.service()`），核心 API 只增不改，废弃走 major。
7. 第一天就带 `botId`、`platform`，事件名带命名空间（`qq.group.at_message`）。
8. 契约冻结点是 `definePlugin` 的入口形状与声明清单（manifest.json）；构建产物是瞬态产物，不作为分发契约，构建工具链版本随仓库 pin。

## 7. Durable Object 政策

DO 按 128 MB × 活跃墙上时钟计费：一个被持续访问的 DO 一天约 11,000 GB-s，免费版每日额度 13,000 GB-s。因此**核心主路径不碰 DO**（验签、匹配、分发、回复只用 KV/D1）。对插件不做限制：可声明自定义 DO 类（投影时前缀重导出为 `P_<插件>_<类>` 并注册），框架负责成本可见与文档说明。

## 8. 冲突处理

- 命令名：manifest 静态声明，安装时检测到重名给出警告（不拦）；运行时按 `priority` 排序，命令默认 `block: true`
- 同事件多处理器：priority + block（NoneBot 模型），快照可覆盖优先级
- 被动回复配额：`msg_seq` 由 Session 集中分配并设上限（默认 5）
- 存储：KV `p:<name>:` 前缀、D1 `p_<name>_` 表前缀由框架强制
- 依赖/互斥：manifest `depends` / `conflicts`
- HTTP 路由：统一挂 `/p/<name>/`
- Cron：框架只注册一个 Cron Trigger，按插件表达式分发（免费版 Trigger 仅 5 个）
- 全局篡改：同 isolate 无法禁止，靠构建期 lint 与审核

## 9. 里程碑

**M1（本仓库当前）**：sdk / api / runtime / projector / plugin-cli / 四个示例插件 / 种子应用 / 插件模板。平台能力覆盖见 `capabilities.md`：按键（自动升级 markdown）、`buttons` 匹配器与交互自动 ack、event_id 被动回复、引用、视频/语音/文件、流式（单聊）、撤回、输入中、群管理。清单投影、多模块部署元数据、Versions API 客户端已实现但**未对线上 API 实测**。

## 10. 面板与插件页面

面板是 `@qqbot/ui`（Vue 3），构建产物内联进 Worker 制品由运行时返回——自我部署不需要额外的 Cloudflare API，UI 与管理 API 永远同版本。插件页面走**解耦**方案：插件路由返回任意 HTML，面板以 sandbox iframe 打开，`@qqbot/ui-bridge` 提供 token、主题与 postMessage 通道；不做"插件写 Vue 组件挂进面板"的原生扩展，避免把面板组件 API 变成公共契约。鉴权是无状态 HMAC 令牌（会话 7 天、桥接 1 小时且限定插件），轮换 `ADMIN_TOKEN` 即全部失效。详见 `ui.md`，设计 token 见 `../design-system/qqbot-workers/MASTER.md`。

## 11. 里程碑（更新）

**M2（当前）**：清单入 D1（`rt_manifest_plugins` + `rt_installs` 账本）、构建清单 API（`GET /admin/build-manifest`）、安装/卸载端点（声明清单校验、conflicts/depends 检测）、Builds API 触发与构建状态/commit 同步、seed 自部署脚本（git 源码构建 + Versions API 健康检查部署 + 仓库清单回退）、面板安装入口（粘贴仓库链接 + 构建记录列表）、插件数据所有权（D1 表名前缀强制、卸载清理、`GET /admin/storage` 存储视图，见第 5 节）。线上 Builds 已实测跑通（Versions API 上传 → 健康检查 → 切流量，`workers_dev: false` 下预览地址同样可用）。构建日志内嵌未做。

**M3**：多轮对话（`session.prompt`，Conversation DO）、`ctx.store(scope)` 通用 DO、面板安装页（源码安装 + 构建日志内嵌）、Access 集成指引、Dynamic Workers 脚本引擎插件。

**M3**：多轮对话（`session.prompt`，Conversation DO）、`ctx.store(scope)` 通用 DO、Access 集成指引、Dynamic Workers 脚本引擎插件。
