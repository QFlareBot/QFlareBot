import { collectDurableObjects } from './glue.js'
import { KEPT_BINDING_TYPES, type BaseBindings, type DeployManifest, type VersionMetadata, type WorkerBinding } from './types.js'

/** `workers/tag` 取投影哈希前缀（平台上限 100 字符） */
export const TAG_LENGTH = 20

export function defaultMessage(manifest: DeployManifest, hash: string): string {
  return `qqbot projection ${hash.slice(0, 8)} · core ${manifest.core.version} · ${manifest.plugins.length} plugins`
}

export function buildBindings(bindings: BaseBindings, manifest: DeployManifest): WorkerBinding[] {
  const out: WorkerBinding[] = [
    { type: 'kv_namespace', name: bindings.kv.binding, namespace_id: bindings.kv.namespaceId },
    { type: 'd1', name: bindings.d1.binding, database_id: bindings.d1.databaseId },
  ]
  if (bindings.r2) out.push({ type: 'r2_bucket', name: bindings.r2.binding, bucket_name: bindings.r2.bucketName })
  for (const [name, text] of Object.entries(bindings.vars ?? {})) {
    out.push({ type: 'plain_text', name, text })
  }
  for (const d of collectDurableObjects(manifest.plugins)) {
    out.push({ type: 'durable_object_namespace', name: d.exportName, class_name: d.exportName })
  }
  return out
}

export function buildVersionMetadata(opts: {
  manifest: DeployManifest
  bindings: BaseBindings
  compatibilityDate: string
  compatibilityFlags?: string[]
  hash: string
  message?: string
}): VersionMetadata {
  const metadata: VersionMetadata = {
    main_module: 'index.js',
    compatibility_date: opts.compatibilityDate,
    bindings: buildBindings(opts.bindings, opts.manifest),
    // 少了这行，每次部署都会清空 Worker 上的全部 secret，见 KEPT_BINDING_TYPES
    keep_bindings: [...KEPT_BINDING_TYPES],
    annotations: {
      'workers/message': opts.message ?? defaultMessage(opts.manifest, opts.hash),
      'workers/tag': opts.hash.slice(0, TAG_LENGTH),
    },
  }
  if (opts.compatibilityFlags?.length) metadata.compatibility_flags = [...opts.compatibilityFlags]

  const durableObjects = collectDurableObjects(opts.manifest.plugins)
  if (durableObjects.length > 0) {
    metadata.exports = Object.fromEntries(
      durableObjects.map((d) => [d.exportName, { type: 'durable-object', storage: 'sqlite' }]),
    )
  }
  return metadata
}
