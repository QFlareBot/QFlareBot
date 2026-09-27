import { Blocks, Database, FlaskConical, LayoutDashboard, Settings, Store } from 'lucide-vue-next'
import type { Component } from 'vue'

export interface NavItem {
  to: string
  label: string
  icon: Component
}

/** 主导航；桌面侧栏与手机抽屉共用 */
export const NAV: NavItem[] = [
  { to: '/', label: '概览', icon: LayoutDashboard },
  { to: '/plugins', label: '插件', icon: Blocks },
  { to: '/market', label: '市场', icon: Store },
  { to: '/storage', label: '存储', icon: Database },
  { to: '/debug', label: '调试', icon: FlaskConical },
  { to: '/settings', label: '设置', icon: Settings },
]

/** 当前路径该点亮哪一项：插件详情页算「插件」，插件页面按自己的路径 */
export function activeNav(path: string): string {
  if (path.startsWith('/plugin-ui/')) return path
  if (path === '/') return '/'
  return NAV.find((n) => n.to !== '/' && (path === n.to || path.startsWith(`${n.to}/`)))?.to ?? ''
}
