# 设计决策记录

这份文档记录框架的核心决策与理由，改动契约前先读它。日期：2026-09-18。

## 1. 为什么是 Cloudflare Workers

QQ 开放平台 Webhook 已不再要求 IP 白名单（在 `qqbot-cfworker` 原型中实测：回调验证、被动回复、连续回复、富媒体、单聊主动消息全部跑通）。Webhook 模式没有长连接、没有心跳，Worker 只在有事件时被唤醒，"永久运行"零成本。

## 2. 语言与工具

TypeScript + wrangler。Workers 是 JS 一等公民，WebCrypto/fetch 原生；Rust/Python 在此 I/O 密集场景无收益且生态不足。零第三方运行时依赖（Hono/zod 都没用），bundle 极小。

## 3. 单 Worker，自我部署

一个 Worker 同时承担 bot 与管理面。它可以通过 Cloudflare Versions API 重新部署自己：上传版本（不切流量）→ 打预览地址 `/healthz` → 切流量。三个安全阀让单 Worker 足够稳：

1. 先上传后切流量，健康检查失败就丢弃版本
2. 插件用动态 `import()`，某个插件求值抛错只影响自己，面板照常可用
3. 快照里的 `safeMode` 跳过全部插件；Cloudflare 后台本身还有版本回滚

代价：Cloudflare API token 与插件代码同 isolate，同 realm 无沙箱。这与 NoneBot/Koishi 的"装的插件即可信代码"前提一致，文档中说明并建议 bot 单开一个 Cloudflare 账号。

## 4. 插件：编译期打包，运行时开关，清单驱动

Workers 没有可写文件系统，也禁止 `eval`，"下载到本地再 import" 不成立。我们采用：

- **插件是 npm 包**，发布时用 `qqbot-plugin build` 打成**自包含单文件 ESM** `dist/plugin.js` + 纯数据 `dist/manifest.json`。制品格式视为永久冻结。
- **清单（DeployManifest）是唯一真相**：core 版本 + 已装插件（name/version/source/integrity/enabled/manifest）。线上存 D1（事务、历史），运行时需要的那份（启用、配置、优先级）发布到 KV 快照，制品缓存到 R2。
- **bundle 是清单的投影**：`@qqbot/projector` 读清单、拉制品、生成胶水 `index.js`（`import` runtime，动态 `import()` 各插件，静态重导出插件 DO 类）与版本元数据，多模块上传，**不需要 esbuild**。
- 安装/升级/卸载 = 改清单 → 重新投影 → 部署。启用/禁用/改配置 = 改 KV 快照，不部署。
- 种子仓库的构建命令跑同一个投影库，所以 GitHub（Workers Builds）触发的部署与 Worker 自我部署产出一致，互不覆盖。

Dynamic Workers（Worker Loader，付费版 beta）保留为**不可信脚本**场景的执行后端（如群管自定义脚本、LLM 生成代码），制品格式相同，但不是插件系统的基础。独立 Worker（Service Binding）保留给独立迭代的重型子系统。

## 5. 契约稳定性规则

1. **SDK 与 Runtime 分离**：`@qqbot/sdk` 只有类型、`definePlugin`（恒等函数）与测试工具；插件 bundle 中不允许任何运行时 import，所有能力由注入的 `ctx`/`session` 提供。框架升级不要求插件重新打包。
2. **契约有版本**（`apiVersion`）；旧契约的适配器是独立 compat 包，只在清单含旧插件时投影进 bundle。
3. **处理器只接收一个对象参数**，返回值也是对象；加字段永远兼容。
4. **永远暴露原始层**：`session.raw`、`ctx.api.raw()`。QQ 新增能力不必等框架发版。
5. **触发器与配置 schema 是数据**（manifest / JSON Schema），面板与安装器不执行插件代码。
6. **能力优先做成服务**（`services` / `depends` / `ctx.service()`），核心 API 只增不改，废弃走 major。
7. 第一天就带 `botId`、`platform`，事件名带命名空间（`qq.group.at_message`）。
8. 制品格式（单 ESM + manifest.json）永久冻结。

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

**M1（本仓库当前）**：sdk / api / runtime / projector / plugin-cli / 三个示例插件 / 种子应用 / 插件模板。清单投影、多模块部署元数据、Versions API 客户端已实现但**未对线上 API 实测**。

**M2**：面板（Workers Static Assets）、D1 清单存储与 KV 快照发布、面板内安装（npm 搜索 → 拉制品 → 投影 → 自我部署 → 健康检查 → 切流量，SSE 进度）、自愈对比。

**M3**：多轮对话（`session.prompt`，Conversation DO）、`ctx.store(scope)` 通用 DO、Access 集成指引、Dynamic Workers 脚本引擎插件。
