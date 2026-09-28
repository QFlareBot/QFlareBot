/**
 * 这次会用到的资源名。规则与 scripts/bootstrap/lib/bootstrap.mjs 一致：留空用默认名，
 * none 表示不启用；KV 必须有，所以 KV 填 none 也按 Worker 名。name 为 null 表示不启用。
 */
export function resourcePlan(input: {
  workerName: string
  defaultWorkerName: string
  kvName: string
  d1Name: string
  r2Name: string
}): Array<{ label: string; name: string | null }> {
  const worker = input.workerName.trim() || input.defaultWorkerName || 'qqbot'
  const kv = input.kvName && input.kvName !== 'none' ? input.kvName : worker
  const d1 = input.d1Name === 'none' ? null : input.d1Name || worker
  const r2Input = input.r2Name.trim()
  const r2 = r2Input === 'none' ? null : r2Input || `${worker}-artifacts`
  return [
    { label: 'Worker', name: worker },
    { label: 'KV', name: kv },
    { label: 'D1', name: d1 },
    { label: 'R2', name: r2 },
  ]
}
