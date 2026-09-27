import { describe, expect, it } from 'vitest'
import { activeNav } from './nav.js'

describe('activeNav', () => {
  it('概览只认根路径', () => {
    expect(activeNav('/')).toBe('/')
  })
  it('插件详情页、添加插件都点亮「插件」', () => {
    expect(activeNav('/plugins')).toBe('/plugins')
    expect(activeNav('/plugins/t2i')).toBe('/plugins')
    expect(activeNav('/market')).toBe('/plugins')
  })
  it('插件页面按自己的路径', () => {
    expect(activeNav('/plugin-ui/t2i')).toBe('/plugin-ui/t2i')
  })
  it('前缀相同但不是子路径的不算', () => {
    expect(activeNav('/pluginsx')).toBe('')
  })
})
