# @qqbot/projector

把**部署清单**（存于 D1 的真相：runtime 版本 + 已安装插件列表）投影为可直接上传的 Worker bundle，并通过 Cloudflare **Versions API** 完成"上传版本 → 预览健康检查 → 切流量"。

- 核心库零第三方依赖，不用 Node API，可同时跑在 Node 与 Workers（面板端）里
- CLI `qqbot-project` 供本地开发：读本地清单与 `wrangler.jsonc`，产出 bundle 与 `wrangler.generated.jsonc`

## 投影结果

```
index.js          胶水：import runtime、静态重导出插件 DO 类、动态 import 各插件
runtime.js        @qqbot/runtime 制品
plugins/<name>.js 各插件制品（禁用的插件也打进去，启用/禁用是运行时状态）
```

胶水示例：

```js
// 由 @qqbot/projector 生成，勿手改
import { createRuntime } from './runtime.js'
export { Game as P_foo_Game } from './plugins/foo.js'

const PROJECTION = "sha256-<hash>"

const plugins = [
  { manifest: {...}, load: () => import('./plugins/foo.js') },
]

export default createRuntime({ plugins, projection: PROJECTION })
```

- 插件用动态 import，运行时可按需加载并隔离求值错误；Durable Object 类必须静态重导出，导出名 `P_<插件名非字母数字换为 _>_<类名>`，同时作为 DO binding 名与 `class_name`
- `hash`：由 `core@version+integrity`、`ui@version+integrity`（有面板时）与各插件 `name@version+integrity`（按 name 排序）确定性计算的 sha256 hex；与插件顺序、enabled 无关。core / ui 的 integrity 是实际拉到的制品算的：它们从机器人仓库现编，改了代码不一定改版本号。`PROJECTION = 'sha256-' + hash`，`workers/tag` 取 hash 前 20 位。哈希只用来展示与打 tag，没有地方跨版本比较它
- git 插件由 `qqbot-plugin build` 打包时，alias 指过去的 `@qqbot/sdk` 解析在固定的虚拟命名空间里（产物注释是 `// qqbot-sdk:src/…`），产物不带构建机的目录结构——同一组插件在哪台机器上构建 integrity 都一样，哈希才稳定

## API

```ts
import { project, deploy, CloudflareWorkersApi, createHttpFetcher } from '@qqbot/projector'

const projection = await project({
  manifest,                              // DeployManifest
  fetchArtifact: createHttpFetcher(),    // (ref) => Promise<源码>
  bindings: { kv: { binding: 'KV', namespaceId }, d1: { binding: 'DB', databaseId }, r2?, vars? },
  compatibilityDate: '2025-09-01',
  compatibilityFlags: ['nodejs_compat'],
})
// projection: { mainModule, modules, hash, metadata, integrity }
//   metadata  —— Cloudflare "Upload Worker Version" 的 metadata（bindings / exports / annotations）
//   integrity —— 本次实际拉取到的制品 SRI，清单中缺省的 integrity 应回写 D1 锁定

const api = new CloudflareWorkersApi({ accountId, apiToken })
const { versionId, previewUrl } = await deploy({
  api, scriptName: 'my-bot', projection,
  healthCheck: { path: '/healthz?plugins=1', retries: 10, intervalMs: 2000 },   // 默认值；false 跳过
  onProgress: (step) => sse.send(step),   // { stage: 'upload'|'health'|'promote'|'done', message }
})
```

- 健康检查默认打 `/healthz?plugins=1`：运行时把每个插件都求值一遍，有插件加载失败就回 503 并带 `pluginErrors: [{ name, message }]`，`HealthCheckError` 的 `pluginErrors` 与错误信息里列出是哪些插件（旧运行时忽略这个参数、照常回 200）
- `deploy()` 抛出的错误带 `stage`（`upload` / `secrets` / `subdomain` / `health` / `promote`，见 `DeployErrorStage`）。调用方据此判断能不能换条路重来：只有 `upload` 这一步走不通才值得降级，版本传上去之后任何一步报错都不能降级，否则会绕过健康检查直接上线

其他导出：

| 模块 | 导出 |
| --- | --- |
| `hash` | `computeProjectionHash(manifest, { core?, ui? })`、`canonicalProjectionInput`、`projectionId`、`sha256Hex`… |
| `glue` | `generateGlue`、`collectDurableObjects`、`doExportName`、`pluginModulePath` |
| `metadata` | `buildVersionMetadata`、`buildBindings` |
| `artifacts` | `resolveArtifactUrl`、`createHttpFetcher`、`computeIntegrity`、`verifyIntegrity`、`listNpmVersions`、`parseSource` |
| `cloudflare` | `CloudflareWorkersApi`（`uploadVersion` / `deployVersion` / `listVersions` / `listDeployments` / `getWorkersSubdomain` / `previewUrl`）、`CloudflareApiError` |
| `deploy` | `deploy`、`HealthCheckError`、`SecretLossError`、`DeployApi`（便于注入假实现）、`DeployErrorStage`、`PluginLoadError` |
| `jsonc` / `wrangler` | `parseJsonc`、`deriveBindings`、`generateWranglerConfig`（CLI 复用，无 Node 依赖） |

### 制品来源

| source | 解析 |
| --- | --- |
| `npm:<pkg>` | `https://cdn.jsdelivr.net/npm/<pkg>@<version>/dist/plugin.js`（runtime 为 `runtime.js`） |
| `github:<owner>/<repo>` | `https://github.com/<owner>/<repo>/releases/download/v<version>/plugin.js` |
| `url:<https://...>` | 原样 |
| `file:<path>` | 仅 CLI，相对清单文件；核心库遇到抛错 |

`integrity`（`sha256-<base64>`）存在时校验，不匹配抛 `IntegrityError`；缺省时首次拉取计算并随 `projection.integrity` 返回。

## CLI

```sh
qqbot-project build --manifest ./deploy.json --wrangler ./wrangler.jsonc --out ./.projected
```

- 写入 `<out>/index.js`、`runtime.js`、`plugins/*.js` 与 `projection.json`（hash、integrity、metadata）
- 在 wrangler 文件同目录生成 `wrangler.generated.jsonc`：合并原配置并设置 `main`、`no_bundle: true`、`rules: [{ type: 'ESModule', globs: ['**/*.js'] }]`，追加插件 DO 的 `durable_objects.bindings`
- **不合成 `migrations`**：迁移是只追加的历史，构建机没有「上次应用到哪个 tag」的持久状态，造不出来。模板里的 `migrations` 原样保留，并在插件 DO 类没被覆盖时**报错**（附上该追加的条目）。「覆盖」按顺序重放历史来算：`new_classes` / `new_sqlite_classes`、`renamed_classes` 的 `to`、`transferred_classes` 的 `to` 算现存，`deleted_classes` 与 `renamed_classes` 的 `from` 从现存里减掉。类建在 `new_classes`（KV 存储后端）而版本元数据按 sqlite 声明时给一条警告（不失败）。生产路径走 Versions API，用 `exports` 声明 DO 生命周期，不涉及 `migrations`
- bindings 从 `kv_namespaces[0]` / `d1_databases[0]` / `r2_buckets[0]` / `vars` 推导；缺 id 时用 `<provisioned>` 占位并在摘要中提醒
- `CF_D1_ID=none` / `CF_R2_NAME=none` 是「显式跳过该可选资源」的哨兵：它优先于模板里硬编码的值，命中就把对应字段从生成配置里剥掉。所以**模板只该声明 binding 名，别硬编码 `bucket_name` / `database_id`**——硬编码会让剥离分支永远进不去，「R2 不可用即不绑定」的降级随之失效
- KV 没有这个哨兵：运行时无条件用它，`CF_KV_ID=none` 不受支持，按「没解析出来」处理（`projection.json` 的 `bindings.kv` 是 `unresolved`，部署护栏拒绝）
- JSONC 解析先去注释、再单独扫一遍去尾随逗号，逗号与 `]` / `}` 之间隔着注释（`[1, // 说明\n]`）也认得出
- 之后 `wrangler dev -c wrangler.generated.jsonc` 即可本地运行

## 已知限制

- 上传版本 → 预览健康检查 → 切流量这条路已在线上跑通（seed 自部署用的就是它）；带插件 DO 的 `exports` 声明还没在线上实测过
- 含 Durable Object 的 Worker 平台不生成版本预览 URL，因此 `deploy()` 在未显式传 `healthCheck` 时会对含 DO 的投影自动跳过健康检查（显式传对象则强制检查）
- `wrangler deploy` 路径下，含插件 DO 的投影需要**人工维护 `migrations`**（生成器只校验，缺类即报错）。这是 Cloudflare 的模型决定的：迁移是只追加的历史，平台靠「上次应用过的 tag」算增量，而构建机没有这个状态。通过 Versions API 部署不受影响——那条路用 `exports` 声明 DO 生命周期，`migrations` 与 `exports` 互斥，由平台按 `exports` 自动 reconcile（此路径尚未对线上实测）
- 版本元数据 bindings 目前只覆盖 KV / D1 / R2 / plain_text / 插件 DO；`vars` 中非字符串值会被 JSON 序列化为文本
