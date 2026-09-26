import { describe, expect, it } from 'vitest'
import { panelWarnings } from './panel.js'

describe('指令面板宽度检查', () => {
  it('命令名放得下、描述不超宽就不警告', () => {
    expect(panelWarnings({ commands: [{ name: '今日老婆', description: '抽一个群友当老婆' }] })).toEqual([])
  })

  it('命令名太长但有短别名不警告；都太长才警告', () => {
    expect(panelWarnings({ commands: [{ name: '重置强娶时间了啊啊啊', aliases: ['czqqsj'] }] })).toEqual([])
    const [w] = panelWarnings({ commands: [{ name: '超级超级超级长的命令名', aliases: ['也还是很长很长的别名'] }] })
    expect(w).toContain('放不进 QQ 指令面板')
  })

  it('描述超过 30 宽的合成一行提醒会被截断', () => {
    const warnings = panelWarnings({
      commands: [
        { name: 'wife', description: '随机抽取一名近期的活跃群友作为今日老婆' },
        { name: 'rbq', description: '查看本群近三十天被强娶次数最多的十个人' },
        { name: 'ok', description: '够短' },
      ],
    })
    expect(warnings).toEqual(['2 个命令的描述在 QQ 指令面板里会被截断（宽度要 ≤30，约 15 个汉字）：wife（38）、rbq（38）'])
  })
})
