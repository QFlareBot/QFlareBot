import type { Manifest } from '@qqbot/sdk'

/** 部署清单：真相存于 D1，是投影的唯一输入 */
export interface DeployManifest {
  /** @qqbot/runtime 的版本；source 缺省为 `npm:@qqbot/runtime` */
  core: { version: string; source?: string }
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
}

export type ArtifactRef = {
  kind: 'runtime' | 'plugin'
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
  integrity: { core: string; plugins: Record<string, string> }
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

export interface VersionMetadata {
  main_module: 'index.js'
  compatibility_date: string
  compatibility_flags?: string[]
  bindings: WorkerBinding[]
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
