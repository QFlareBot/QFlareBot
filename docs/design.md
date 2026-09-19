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
3. 快照里的 `safeMode` 跳过全部插件；Cloudflare 后台版本回滚、以及"恢复 D1 清单快照 + 重新触发构建"是最后手段
4. 部署凭证不进 Worker：Worker 只持有 Builds 触发 token（user-scoped，权限仅触发构建与读构建状态）；编译与部署凭证由构建机持有

代价与信任模型：插件代码与框架同 isolate、同 realm 无沙箱，permissions 声明只是"知情同意"，不是安全边界。这与 NoneBot/Koishi 的"装的插件即可信代码"前提一致，文档中说明并建议 bot 单开一个 Cloudflare 账号。

## 4. 插件：源码分发，清单驱动，构建时编译

Workers 没有可写文件系统，也禁止 `eval`，"下载到本地再 import" 不成立；Worker 内编译则受 CPU/体积限制且要自建依赖解析，同样不成立。因此插件以**源码**分发、在构建机编译：

- **插件是源码仓库**（`git:<owner>/<repo>@<commit>[#<子目录>]`）。作者运行 `qqbot-plugin build` 生成 `dist/plugin.js` + `dist/manifest.json`，并把 `manifest.json` 作为**声明文件提交进仓库**——面板与安装器只读它（权限展示、撞名/依赖/冲突检测），永不执行插件代码。
- **安装 = 写 D1 清单 + 触发构建**：`POST /admin/manifest/plugins` 校验声明清单（apiVersion、撞名、conflicts、depends）后写入 D1 的 `rt_manifest_plugins`；`POST /admin/builds` 调 Builds API 触发重建。安装/升级/卸载/构建全程记录在 `rt_installs` 账本（清单哈希、build_uuid、commit、状态），构建机拉到的清单哈希与触发时不一致即构建失败。
- **清单真相分层**：框架版本（core/ui）与内置插件在仓库的 `qqbot.manifest.json`（git 管，diff/回滚免费）；已安装插件集在 D1（运行时可写、有账本）；两者在构建时合并（D1 同名覆盖，可借此下架内置插件）。启用/禁用/改配置仍是 KV 快照，不触发构建。
- **构建时校验**：构建机按 commit 拉 tarball、esbuild 就地打包，重新抽取清单并与声明清单比对，不一致即失败——防止声明与代码漂移。产物记 SRI 完整性。
- 旧制品源（`npm:` / GitHub Release 的 `github:` / `url:`）投影器仍支持，属旧模型兼容，不再推荐。
- Dynamic Workers（Worker Loader，付费版 beta）保留为**不可信脚本**场景的执行后端（如群管自定义脚本、LLM 生成代码），制品格式相同，但不是插件系统的基础。

种子仓库的本地投影命令（`pnpm project`）与构建机（`manifest:prepare`）跑同一个投影库，产出一致（投影哈希相同），互不覆盖。

## 5. 契约稳定性规则

1. **SDK 与 Runtime 分离**：`@qqbot/sdk` 只有类型、`definePlugin`（恒等函数）与测试工具；插件 bundle 中不允许任何运行时 import，所有能力由注入的 `ctx`/`session` 提供。框架升级不要求插件重新打包。
2. **契约有版本**（`apiVersion`）；旧契约的适配器是独立 compat 包，只在清单含旧插件时投影进 bundle。
3. **处理器只接收一个对象参数**，返回值也是对象；加字段永远兼容。
4. **永远暴露原始层**：`session.raw`、`ctx.api.raw()`。QQ 新增能力不必等框架发版。
5. **触发器与配置 schema 是数据**（manifest / JSON Schema），面板与安装器不执行插件代码。
6. **能力优先做成服务**（`services` / `depends` / `ctx.service()`），核心 API 只增不改，废弃走 major。
7. 第一天就带 `botId`、`platform`，事件名带命名空间（`qq.group.at_message`）。
8. 契约冻结点是 `definePlugin` 的入口形状与声明清单（manifest.json）；构建产物是瞬态产物，不作为分发契约，构建工具链版本随仓库 pin。

## 6. Durable Object 政策

DO 按 128 MB × 活跃墙上时钟计费：一个被持续访问的 DO 一天约 11,000 GB-s，免费版每日额度 13,000 GB-s。因此**核心主路径不碰 DO**（验签、匹配、分发、回复只用 KV/D1）。对插件不做限制：可声明自定义 DO 类（投影时前缀重导出为 `P_<插件>_<类>` 并注册），框架负责成本可见与文档说明。

## 7. 冲突处理

- 命令名：manifest 静态声明，安装前检测；运行时按 `priority` 排序，命令默认 `block: true`
- 同事件多处理器：priority + block（NoneBot 模型），快照可覆盖优先级
- 被动回复配额：`msg_seq` 由 Session 集中分配并设上限（默认 5）
- 存储：KV `p:<name>:` 前缀、D1 `p_<name>_` 表前缀由框架强制
- 依赖/互斥：manifest `depends` / `conflicts`
- HTTP 路由：统一挂 `/p/<name>/`
- Cron：框架只注册一个 Cron Trigger，按插件表达式分发（免费版 Trigger 仅 5 个）
- 全局篡改：同 isolate 无法禁止，靠构建期 lint 与审核

## 8. 里程碑

**M1（本仓库当前）**：sdk / api / runtime / projector / plugin-cli / 四个示例插件 / 种子应用 / 插件模板。平台能力覆盖见 `capabilities.md`：按键（自动升级 markdown）、`buttons` 匹配器与交互自动 ack、event_id 被动回复、引用、视频/语音/文件、流式（单聊）、撤回、输入中、群管理。清单投影、多模块部署元数据、Versions API 客户端已实现但**未对线上 API 实测**。

## 9. 面板与插件页面

面板是 `@qqbot/ui`（Vue 3），构建产物内联进 Worker 制品由运行时返回——自我部署不需要额外的 Cloudflare API，UI 与管理 API 永远同版本。插件页面走**解耦**方案：插件路由返回任意 HTML，面板以 sandbox iframe 打开，`@qqbot/ui-bridge` 提供 token、主题与 postMessage 通道；不做"插件写 Vue 组件挂进面板"的原生扩展，避免把面板组件 API 变成公共契约。鉴权是无状态 HMAC 令牌（会话 7 天、桥接 1 小时且限定插件），轮换 `ADMIN_TOKEN` 即全部失效。详见 `ui.md`，设计 token 见 `../design-system/qqbot-workers/MASTER.md`。

## 10. 里程碑（更新）

**M2（当前）**：清单入 D1（`rt_manifest_plugins` + `rt_installs` 账本）、构建清单 API（`GET /admin/build-manifest`）、安装/卸载端点（声明清单校验、conflicts/depends 检测）、Builds API 触发与构建状态/commit 同步、seed 自部署脚本（git 源码构建 + Versions API 健康检查部署 + 仓库清单回退）、面板安装入口（粘贴仓库链接 + 构建记录列表）。构建日志内嵌与线上 Builds 实测未做。

**M3**：多轮对话（`session.prompt`，Conversation DO）、`ctx.store(scope)` 通用 DO、面板安装页（源码安装 + 构建日志内嵌）、Access 集成指引、Dynamic Workers 脚本引擎插件。

**M3**：多轮对话（`session.prompt`，Conversation DO）、`ctx.store(scope)` 通用 DO、Access 集成指引、Dynamic Workers 脚本引擎插件。
