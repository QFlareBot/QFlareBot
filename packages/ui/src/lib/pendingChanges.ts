/** 插件页「未上线的改动」：D1 清单里写了、线上还没生效的安装 / 升级 / 卸载，以及撤掉它的办法 */
import type { InstallRecord, LedgerSummary, ManagedPluginsResult } from '../api/types.js'

export interface PendingChange {
  key: string
  kind: 'install' | 'upgrade' | 'uninstall'
  name: string
  title: string
  source: string
  record: LedgerSummary | null
  error: string | null
  /** reinstall：改回线上正在跑的那一份；remove：从清单移除；null：老部署不知道线上是哪一份，撤不了 */
  undo: { type: 'reinstall'; source: string } | { type: 'remove' } | null
}

function failedError(record: LedgerSummary | null): string | null {
  return record?.status === 'failed' ? record.error : null
}

export function pendingChanges(m: ManagedPluginsResult | null): PendingChange[] {
  if (!m) return []
  const out: PendingChange[] = []
  for (const p of m.plugins) {
    const error = p.buildError ?? failedError(p.lastRecord)
    if (p.state === 'not_deployed') {
      out.push({ key: `install:${p.name}`, kind: 'install', name: p.name, title: `安装 ${p.name} ${p.version}`, source: p.source, record: p.lastRecord, error, undo: { type: 'remove' } })
    } else if (p.state === 'differs' && p.live) {
      // 线上是被它覆盖的内置插件：撤销 = 从清单移除，内置的那份留着
      const overridesBuiltin = p.live.from === 'repo'
      const undo: PendingChange['undo'] = overridesBuiltin
        ? { type: 'remove' }
        : p.live.from === 'd1' && p.live.source
          ? { type: 'reinstall', source: p.live.source }
          : null
      const title = `${overridesBuiltin ? '覆盖内置插件' : '升级'} ${p.name} ${p.live.version} → ${p.version}`
      out.push({ key: `upgrade:${p.name}`, kind: 'upgrade', name: p.name, title, source: p.source, record: p.lastRecord, error, undo })
    }
  }
  for (const r of m.removing) {
    out.push({
      key: `uninstall:${r.name}`,
      kind: 'uninstall',
      name: r.name,
      title: `卸载 ${r.name} ${r.version}`,
      source: r.source,
      record: r.lastRecord,
      error: failedError(r.lastRecord),
      undo: { type: 'reinstall', source: r.source },
    })
  }
  return out
}

type Tone = 'neutral' | 'success' | 'warning' | 'danger'

const CHANGE_STATUS: Record<InstallRecord['status'], { tone: Tone; label: string }> = {
  pending: { tone: 'neutral', label: '待构建' },
  building: { tone: 'warning', label: '构建中' },
  ok: { tone: 'neutral', label: '待生效' },
  failed: { tone: 'danger', label: '构建失败' },
}

export function changeStatus(c: PendingChange): { tone: Tone; label: string } {
  return c.error ? CHANGE_STATUS.failed : CHANGE_STATUS[c.record?.status ?? 'pending']
}

export function undoLabel(c: PendingChange): string {
  if (c.kind === 'install') return '卸载'
  if (c.kind === 'uninstall') return '撤销卸载'
  return c.undo?.type === 'remove' ? '撤销覆盖' : '撤销升级'
}
