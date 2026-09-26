import type { RuntimeEnv } from './types.js'

/**
 * 上次发送到 QQ 的指令面板：每个场景（群聊 / 单聊）一行，只在面板发送成功后写一次。
 *
 * 面板据此记住勾选和手改过的名称、描述，也据此提示「插件有变动，QQ 里的面板该重新发送了」。
 * 存 D1 不存 KV：KV 写入额度紧；也不放进运行时快照，快照每个请求都要读，这份只有设置页用
 */
const TABLE = 'rt_qq_panels'
const SCHEMA = `CREATE TABLE IF NOT EXISTS ${TABLE} (scope TEXT PRIMARY KEY, data TEXT NOT NULL, sent_at INTEGER NOT NULL) WITHOUT ROWID`

/** 面板一项：key 是「插件名/命令名」，用来和插件现在的命令对上号 */
export interface SavedPanelItem {
  key: string
  name: string
  desc: string
  selected: boolean
}

export interface SavedPanel {
  items: SavedPanelItem[]
  sentAt: number
}

/** 一个场景最多记这么多项（一个插件的命令加起来也到不了） */
const MAX_ITEMS = 500

let schemaReady: Promise<void> | null = null

function ensureSchema(db: D1Database): Promise<void> {
  schemaReady ??= db.exec(SCHEMA).then(
    () => undefined,
    (err: unknown) => {
      schemaReady = null
      throw err
    },
  )
  return schemaReady
}

/** 测试用 */
export function resetQQPanelSchema(): void {
  schemaReady = null
}

export async function readSavedPanel(env: RuntimeEnv, scope: string): Promise<SavedPanel | null> {
  if (!env.DB) return null
  await ensureSchema(env.DB)
  const row = await env.DB.prepare(`SELECT data, sent_at FROM ${TABLE} WHERE scope = ?`).bind(scope).first<{ data: string; sent_at: number }>()
  if (!row) return null
  try {
    return { items: JSON.parse(row.data) as SavedPanelItem[], sentAt: row.sent_at }
  } catch {
    return null
  }
}

/** 校验面板传来的条目；形状不对返回 null */
export function parseSavedItems(value: unknown): SavedPanelItem[] | null {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return null
  const items: SavedPanelItem[] = []
  for (const v of value) {
    const i = v as Partial<SavedPanelItem> | null
    if (!i || typeof i.key !== 'string' || typeof i.name !== 'string' || typeof i.desc !== 'string' || typeof i.selected !== 'boolean') return null
    items.push({ key: i.key.slice(0, 200), name: i.name.slice(0, 100), desc: i.desc.slice(0, 200), selected: i.selected })
  }
  return items
}

/** 写入并返回写入时刻；没绑 D1 返回 null（面板照样能发，只是记不住） */
export async function writeSavedPanel(env: RuntimeEnv, scope: string, items: SavedPanelItem[]): Promise<number | null> {
  if (!env.DB) return null
  await ensureSchema(env.DB)
  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO ${TABLE} (scope, data, sent_at) VALUES (?, ?, ?) ON CONFLICT(scope) DO UPDATE SET data = excluded.data, sent_at = excluded.sent_at`,
  )
    .bind(scope, JSON.stringify(items), now)
    .run()
  return now
}
