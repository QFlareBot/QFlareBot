/**
 * 设置页「机器人公开地址」的输入整理：去掉首尾空白和结尾斜杠，要求是 https 的 origin（与后端 isHttpsOrigin 一致）。
 * 返回 '' 表示清空，null 表示格式不对
 */
export function normalizePublicUrl(input: string): string | null {
  const value = input.trim().replace(/\/+$/, '')
  if (!value) return ''
  if (!value.startsWith('https://')) return null
  try {
    const url = new URL(value)
    return url.origin === value ? value : null
  } catch {
    return null
  }
}
