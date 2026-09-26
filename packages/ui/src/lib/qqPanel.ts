/**
 * QQ 指令面板的规则与数据整理。
 *
 * 名称、描述的上限按**显示宽度**算，不是字符数：汉字等非 ASCII 算 2，英文数字算 1。
 * 名称 ≤14（约 7 个汉字）、描述 ≤30（约 15 个汉字），超了平台一律回 30013「超出数量限制」，
 * 看着像是面板数量满了，其实是字段太长（社区实测，官方文档写的是字符数）。
 */

export const NAME_MAX = 14
export const DESC_MAX = 30
/** 一个面板最多几项 */
export const ITEMS_MAX = 20

export function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) w += ch.codePointAt(0)! <= 0x7f ? 1 : 2
  return w
}

/** 截到 max 宽度以内，截掉了就补一个省略号（它也算 2） */
export function truncateWidth(s: string, max: number): string {
  if (displayWidth(s) <= max) return s
  let out = ''
  for (const ch of s) {
    if (displayWidth(out + ch) > max - 2) break
    out += ch
  }
  return `${out}…`
}

export interface PanelDraftItem {
  /** 面板上显示、点了会发出去的指令：命令名或能放下的别名 */
  name: string
  desc: string
  onlyAdmin: boolean
  selected: boolean
  plugin: string
  /** 命令名与别名都超宽，放不进面板 */
  tooWide: boolean
}

interface CommandLike {
  name: string
  description?: string
  aliases?: string[]
  permission?: string
}
interface PluginLike {
  name: string
  displayName?: string
  enabled: boolean
  commands: CommandLike[]
}

/**
 * 已启用插件的命令整理成面板条目。名称不能截断——截了就对不上命令——所以命令名放不下时换一个放得下的别名，
 * 都放不下的标成 tooWide、默认不选；描述截断即可。默认选中前 ITEMS_MAX 个放得下的
 */
export function draftItems(plugins: PluginLike[]): PanelDraftItem[] {
  let picked = 0
  return plugins
    .filter((p) => p.enabled)
    .flatMap((p) =>
      p.commands.map((c) => {
        const name = [c.name, ...(c.aliases ?? [])].find((n) => displayWidth(n) <= NAME_MAX)
        const tooWide = name === undefined
        const selected = !tooWide && picked < ITEMS_MAX
        if (selected) picked++
        return {
          name: name ?? c.name,
          desc: truncateWidth(c.description?.trim() || `${p.displayName || p.name} 的指令`, DESC_MAX),
          // 声明了权限的命令映射为平台原生的「仅管理员可点击」
          onlyAdmin: c.permission === 'bot_admin' || c.permission === 'group_admin',
          selected,
          plugin: p.displayName || p.name,
          tooWide,
        }
      }),
    )
}

/** 选中的条目拼成创建面板的请求体（字段按官方 schema，见 docs/capabilities.md） */
export function panelBody(scope: string, items: PanelDraftItem[]): Record<string, unknown> {
  return {
    scope,
    target_type: 'all',
    panel: {
      remark: '由 QFlareBot 面板同步',
      items: items
        .filter((i) => i.selected)
        .map((i) => ({ type: 'command', name: i.name, desc: i.desc, ...(i.onlyAdmin ? { only_admin: true } : {}) })),
    },
  }
}

export interface PanelSummary {
  id: string
  targetType: string
  names: string[]
}

/** 查询接口的 records 字段名没有全部核对过，按常见写法兜着取，取不到的就留空 */
export function summarizePanels(data: unknown): PanelSummary[] {
  const records = (data as { records?: unknown[] } | null)?.records
  if (!Array.isArray(records)) return []
  return records.map((r) => {
    const rec = (r ?? {}) as Record<string, unknown>
    const panel = (rec.panel ?? rec) as { items?: Array<{ name?: unknown }> }
    return {
      id: String(rec.panel_id ?? rec.id ?? ''),
      targetType: typeof rec.target_type === 'string' ? rec.target_type : '',
      names: Array.isArray(panel.items) ? panel.items.map((i) => String(i?.name ?? '')).filter(Boolean) : [],
    }
  })
}

/** 平台错误翻成人话；30013 最容易误会 */
export function explainPlatformError(status: number, data: unknown): string {
  const d = (data ?? {}) as { message?: unknown; msg?: unknown; code?: unknown; err_code?: unknown }
  const message = String(d.message ?? d.msg ?? `HTTP ${status}`)
  if (d.code === 30013 || d.err_code === 40030013) {
    return `${message}（30013）：通常是某一项的名称或描述太长（名称约 7 个汉字、描述约 15 个汉字以内），也可能是面板数量满了`
  }
  const code = d.code ?? d.err_code
  // 运行时转过来的报错（换 token 失败等）message 里已经带了错误码
  return code !== undefined && !message.includes(String(code)) ? `${message}（错误码 ${String(code)}）` : message
}
