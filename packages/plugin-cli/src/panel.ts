import type { Manifest } from '@qqbot/sdk'

/**
 * 构建时检查命令放不放得进 QQ 指令面板，只警告、不拦构建。
 *
 * QQ 按显示宽度算（汉字等非 ASCII 算 2，英文数字算 1）：名称 ≤14、描述 ≤30。
 * 名称要和命令对得上、不能截断，所以命令名和别名都放不下时这条命令进不了面板；
 * 描述超了会被面板截断。规则和面板里的 packages/ui/src/lib/qqPanel.ts 是同一套，改一边要改另一边。
 */
const NAME_MAX = 14
const DESC_MAX = 30

function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) w += ch.codePointAt(0)! <= 0x7f ? 1 : 2
  return w
}

/** 放不进面板的命令一条一条说；描述会被截断的只是显示少几个字，合成一行 */
export function panelWarnings(manifest: Pick<Manifest, 'commands'>): string[] {
  const out: string[] = []
  const truncated: string[] = []
  for (const c of manifest.commands) {
    const names = [c.name, ...(c.aliases ?? [])]
    if (!names.some((n) => displayWidth(n) <= NAME_MAX)) {
      out.push(`命令「${c.name}」放不进 QQ 指令面板：名称宽度要 ≤${NAME_MAX}（约 7 个汉字），加一个短一点的别名就行`)
    }
    if (c.description && displayWidth(c.description) > DESC_MAX) truncated.push(`${c.name}（${displayWidth(c.description)}）`)
  }
  if (truncated.length) {
    out.push(`${truncated.length} 个命令的描述在 QQ 指令面板里会被截断（宽度要 ≤${DESC_MAX}，约 15 个汉字）：${truncated.join('、')}`)
  }
  return out
}
