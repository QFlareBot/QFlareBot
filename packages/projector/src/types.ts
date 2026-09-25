import type { Manifest } from '@qqbot/sdk'

/** 部署清单：真相存于 D1，是投影的唯一输入 */
export interface DeployManifest {
  /** @qqbot/runtime 的版本；source 缺省为 `npm:@qqbot/runtime` */
  core: { version: string; source?: string }
  /** 管理面板 @qqbot/ui 的版本；缺省则不带面板（headless）；source 缺省为 `npm:@qqbot/ui` */
  ui?: { version: string; source?: string }
  plugins: InstalledPlugin[]
}

export interface InstalledPlugin {
  name: string
  version: string
  /** 制品来源：`npm:<pkg>` | `github:<owner>/<repo>` | `url:<https://...>` | `file:<path>`（仅 CLI 本地开发） */
  source: string
  /** SRI 格式 `sha256-<base64>`，缺省则首次拉取时计算 */
  integrity?: string
  /** 禁用的插件也打进 bundle，启用/禁用是运行时状态，不触发重新部署 */
  enabled: boolean
  manifest: Manifest
  /** 出处：由构建机写入，投影时原样带进入口模块；不写就是「出处未知」（老清单、本地投影） */
  origin?: PluginOrigin
}

/**
 * 插件在部署清单里的出处。运行时靠它回答「线上这一份是面板装的还是仓库内置的、钉在哪个 commit」，
 * 面板才分得清已上线、待上线与构建失败。不参与投影哈希——同样的代码不该因为出处不同算出两个哈希。
 */
export interface PluginOrigin {
  /** d1：面板 / 管理 API 装进 D1 清单的；repo：仓库 qqbot.manifest.json 内置的 */
  from: 'd1' | 'repo'
  /** 原始来源。git: 源码构建的插件在构建机上会被改写成本地产物路径，这里留的是改写之前的那个 */
  source: string
}

export type ArtifactRef = {
  kind: 'runtime' | 'ui' | 'plugin'
  name: string
  version: string
  source: string
}

export type FetchArtifact = (ref: ArtifactRef) => Promise<string>

export interface BaseBindings {
  kv: { binding: string; namespaceId: string }
  d1: { binding: string; databaseId: string }
  r2?: { binding: string; bucketName: string }
  vars?: Record<string, string>
}

export interface ProjectOptions {
  manifest: DeployManifest
  fetchArtifact: FetchArtifact
  bindings: BaseBindings
  compatibilityDate: string
  compatibilityFlags?: string[]
  /** 写入版本注释 `workers/message`，缺省自动生成 */
  message?: string
}

export interface Projection {
  mainModule: 'index.js'
  /** 文件名 → 源码 */
  modules: Record<string, string>
  /** 由 core 版本 + 各插件 name@version+integrity 确定性计算的 sha256（hex） */
  hash: string
  metadata: VersionMetadata
  /** 本次实际拉取到的制品摘要（SRI），供上层回写清单锁定版本 */
  integrity: { core: string; ui?: string; plugins: Record<string, string> }
}

/** 插件 Durable Object 类在 bundle 顶层的重导出信息 */
export interface DurableObjectExport {
  plugin: string
  className: string
  /** `P_<插件名去特殊字符>_<类名>`，同时用作 binding 名与 class_name */
  exportName: string
}

// ---------- Cloudflare "Upload Worker Version" 元数据 ----------

export type WorkerBinding =
  | { type: 'kv_namespace'; name: string; namespace_id: string }
  | { type: 'd1'; name: string; database_id: string }
  | { type: 'r2_bucket'; name: string; bucket_name: string }
  | { type: 'plain_text'; name: string; text: string }
  | { type: 'durable_object_namespace'; name: string; class_name: string }

export interface DurableObjectExportMeta {
  type: 'durable-object'
  storage: 'sqlite'
}

/**
 * 上传版本时按类型保留上一版的 binding。
 *
 * `bindings` 是**整体替换**语义：没列进去的绑定，新版本里就不存在。而 secret 按
 * 定义不会写在 wrangler.jsonc 里，所以不声明保留的话，每次自部署都会把 Worker 上
 * 的 secret 全部抹掉——并且是在**上传那一刻**，「先上传后切流量」的健康检查根本
 * 拦不住：流量一秒没切，凭证已经没了。
 */
export const KEPT_BINDING_TYPES = ['secret_text', 'secret_key', 'secrets_store_secret'] as const

export interface VersionMetadata {
  main_module: 'index.js'
  compatibility_date: string
  compatibility_flags?: string[]
  bindings: WorkerBinding[]
  /** 见 KEPT_BINDING_TYPES；不带它等于每次部署清空所有 secret */
  keep_bindings?: string[]
  /** 仅在有 DO 时出现；平台据此自动创建/迁移命名空间 */
  exports?: Record<string, DurableObjectExportMeta>
  annotations: {
    'workers/message': string
    'workers/tag': string
  }
}

// ---------- 部署编排 ----------

export type DeployStage = 'upload' | 'health' | 'promote' | 'done'

export interface DeployStep {
  stage: DeployStage
  message: string
}

export interface DeployResult {
  versionId: string
  hash: string
  /** 仅在执行了健康检查时存在 */
  previewUrl?: string
}
