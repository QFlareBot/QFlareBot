import { describe, expect, it } from 'vitest'
import {
  DESC_MAX,
  displayWidth,
  draftItems,
  explainPlatformError,
  mergeSaved,
  panelBody,
  summarizePanels,
  toSaved,
  truncateWidth,
} from './qqPanel.js'

describe('显示宽度', () => {
  it('汉字算 2，英文数字算 1', () => {
    expect(displayWidth('echo')).toBe(4)
    expect(displayWidth('今日老婆')).toBe(8)
    expect(displayWidth('rbq排行')).toBe(7)
  })

  it('截断到上限以内并补省略号', () => {
    const desc = '随机抽取一名近期的活跃群友作为今日老婆'
    expect(displayWidth(desc)).toBe(38)
    const cut = truncateWidth(desc, DESC_MAX)
    expect(displayWidth(cut)).toBeLessThanOrEqual(DESC_MAX)
    expect(cut.endsWith('…')).toBe(true)
    expect(truncateWidth('短', DESC_MAX)).toBe('短')
  })
})

describe('从插件命令生成面板条目', () => {
  const plugins = [
    {
      name: 'wifepicker',
      displayName: '今日老婆',
      enabled: true,
      commands: [
        { name: '今日老婆', description: '随机抽取一名近期的活跃群友作为今日老婆', aliases: ['抽老婆'] },
        { name: '重置强娶时间了啊啊啊', aliases: ['czqqsj'], permission: 'group_admin' },
        { name: '超级超级超级长的命令名', aliases: ['也还是很长很长的别名'] },
      ],
    },
    { name: 'off', enabled: false, commands: [{ name: 'hidden' }] },
  ]

  it('描述按宽度截断；命令名放不下换别名；都放不下的标出来且不选；没启用的插件不出现', () => {
    const items = draftItems(plugins)
    expect(items).toHaveLength(3)
    expect(items[0]).toMatchObject({ name: '今日老婆', selected: true, tooWide: false })
    expect(displayWidth(items[0]!.desc)).toBeLessThanOrEqual(DESC_MAX)
    expect(items[1]).toMatchObject({ name: 'czqqsj', onlyAdmin: true, selected: true })
    expect(items[2]).toMatchObject({ tooWide: true, selected: false })
  })

  it('默认最多选 20 个', () => {
    const many = [{ name: 'p', enabled: true, commands: Array.from({ length: 25 }, (_, i) => ({ name: `c${i}` })) }]
    expect(draftItems(many).filter((i) => i.selected)).toHaveLength(20)
  })

  it('请求体只带选中的，管理员命令带 only_admin', () => {
    const body = panelBody('group', draftItems(plugins)) as { panel: { items: Array<Record<string, unknown>> } }
    expect(body).toMatchObject({ scope: 'group', target_type: 'all' })
    expect(body.panel.items.map((i) => i.name)).toEqual(['今日老婆', 'czqqsj'])
    expect(body.panel.items[1]).toMatchObject({ type: 'command', only_admin: true })
    expect(body.panel.items[0]).not.toHaveProperty('only_admin')
  })
})

describe('并入上次发送的记录', () => {
  const plugins = (names: string[]) => [{ name: 'p', displayName: '插件', enabled: true, commands: names.map((name) => ({ name })) }]

  it('没发送过就原样返回', () => {
    const fresh = draftItems(plugins(['a']))
    expect(mergeSaved(fresh, null)).toEqual({ items: fresh, added: [], removed: [] })
  })

  it('还在的命令沿用上次的勾选和改过的名称、描述；新出现的标新并补选；没了的列出来', () => {
    const saved = {
      sentAt: 1,
      items: [
        { key: 'p/a', name: 'a', desc: '我改过的描述', selected: true },
        { key: 'p/b', name: 'b', desc: 'b 的描述', selected: false },
        { key: 'gone/x', name: 'x', desc: '卸载了', selected: true },
      ],
    }
    const { items, added, removed } = mergeSaved(draftItems(plugins(['a', 'b', 'c'])), saved)
    expect(items.map((i) => [i.key, i.selected, i.desc, !!i.isNew])).toEqual([
      ['p/a', true, '我改过的描述', false],
      ['p/b', false, 'b 的描述', false],
      ['p/c', true, '插件 的指令', true],
    ])
    expect(added.map((i) => i.key)).toEqual(['p/c'])
    expect(removed.map((i) => i.key)).toEqual(['gone/x'])
    expect(toSaved(items)[0]).toEqual({ key: 'p/a', name: 'a', desc: '我改过的描述', selected: true })
  })

  it('新命令补选时也不超过 20 项', () => {
    const names = Array.from({ length: 22 }, (_, i) => `c${i}`)
    const saved = { sentAt: 1, items: names.slice(0, 20).map((n) => ({ key: `p/${n}`, name: n, desc: n, selected: true })) }
    const { items, added } = mergeSaved(draftItems(plugins(names)), saved)
    expect(items.filter((i) => i.selected)).toHaveLength(20)
    expect(added.map((i) => [i.key, i.selected])).toEqual([
      ['p/c20', false],
      ['p/c21', false],
    ])
  })
})

describe('平台返回', () => {
  it('30013 讲清楚多半是字段太长', () => {
    expect(explainPlatformError(400, { message: '超出数量限制', code: 30013, err_code: 40030013 })).toContain('名称或描述太长')
    expect(explainPlatformError(400, { message: '无权限', code: 11253 })).toBe('无权限（错误码 11253）')
    expect(explainPlatformError(0, { message: 'invalid appid or secret（错误码 100016）', code: 100016 })).toBe('invalid appid or secret（错误码 100016）')
  })

  it('面板列表取出 id 与各项名称，字段缺失时留空', () => {
    expect(summarizePanels({ records: [{ panel_id: 'p1', target_type: 'all', panel: { items: [{ name: 'echo' }] } }, {}] })).toEqual([
      { id: 'p1', targetType: 'all', names: ['echo'] },
      { id: '', targetType: '', names: [] },
    ])
    expect(summarizePanels(null)).toEqual([])
  })
})
