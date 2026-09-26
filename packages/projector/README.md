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
- `hash`：由 `core@version` 与各插件 `name@version+integrity`（按 name 排序）确定性计算的 sha256 hex；与插件顺序、enabled 无关。`PROJECTION = 'sha256-' + hash`，`workers/tag` 取 hash 前 20 位

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
  healthCheck: { path: '/healthz', retries: 10, intervalMs: 2000 },   // false 跳过
  onProgress: (step) => sse.send(step),   // { stage: 'upload'|'health'|'promote'|'done', message }
})
```

其他导出：

| 模块 | 导出 |
| --- | --- |
| `hash` | `computeProjectionHash(manifest)`、`canonicalProjectionInput`、`projectionId`、`sha256Hex`… |
| `glue` | `generateGlue`、`collectDurableObjects`、`doExportName`、`pluginModulePath` |
| `metadata` | `buildVersionMetadata`、`buildBindings` |
| `artifacts` | `resolveArtifactUrl`、`createHttpFetcher`、`computeIntegrity`、`verifyIntegrity`、`listNpmVersions`、`parseSource` |
| `cloudflare` | `CloudflareWorkersApi`（`uploadVersion` / `deployVersion` / `listVersions` / `listDeployments` / `getWorkersSubdomain` / `previewUrl`）、`CloudflareApiError` |
| `deploy` | `deploy`、`HealthCheckError`、`DeployApi`（便于注入假实现） |
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
- **不合成 `migrations`**：迁移是只追加的历史，构建机没有「上次应用到哪个 tag」的持久状态，造不出来。模板里的 `migrations` 原样保留，并在插件 DO 类没被任何一项覆盖时**报错**（附上该追加的条目）。生产路径走 Versions API，用 `exports` 声明 DO 生命周期，不涉及 `migrations`
- bindings 从 `kv_namespaces[0]` / `d1_databases[0]` / `r2_buckets[0]` / `vars` 推导；缺 id 时用 `<provisioned>` 占位并在摘要中提醒
- `CF_D1_ID=none` / `CF_R2_NAME=none` 是「显式跳过该可选资源」的哨兵：它优先于模板里硬编码的值，命中就把对应字段从生成配置里剥掉。所以**模板只该声明 binding 名，别硬编码 `bucket_name` / `database_id`**——硬编码会让剥离分支永远进不去，「R2 不可用即不绑定」的降级随之失效
- 之后 `wrangler dev -c wrangler.generated.jsonc` 即可本地运行

## 已知限制

- 上传版本 → 预览健康检查 → 切流量这条路已在线上跑通（seed 自部署用的就是它）；带插件 DO 的 `exports` 声明还没在线上实测过
- 含 Durable Object 的 Worker 平台不生成版本预览 URL，因此 `deploy()` 在未显式传 `healthCheck` 时会对含 DO 的投影自动跳过健康检查（显式传对象则强制检查）
- `wrangler deploy` 路径下，含插件 DO 的投影需要**人工维护 `migrations`**（生成器只校验，缺类即报错）。这是 Cloudflare 的模型决定的：迁移是只追加的历史，平台靠「上次应用过的 tag」算增量，而构建机没有这个状态。通过 Versions API 部署不受影响——那条路用 `exports` 声明 DO 生命周期，`migrations` 与 `exports` 互斥，由平台按 `exports` 自动 reconcile（此路径尚未对线上实测）
- 版本元数据 bindings 目前只覆盖 KV / D1 / R2 / plain_text / 插件 DO；`vars` 中非字符串值会被 JSON 序列化为文本
