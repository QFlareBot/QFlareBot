import { describe, expect, it } from 'vitest'
import { enumIndex, enumOptions, enumValueAt, parseJsonDraft } from './schemaForm.js'

describe('枚举下拉', () => {
  it('数字 / 布尔枚举按下标写回原始值，不会变成字符串（运行时严格比较，"2" 会 400）', () => {
    const values = [1, 2, 3]
    const options = enumOptions(values)
    expect(options).toEqual([
      { value: '0', label: '1' },
      { value: '1', label: '2' },
      { value: '2', label: '3' },
    ])
    expect(enumValueAt(values, options[1]!.value)).toBe(2)
    expect(enumValueAt([true, false], '1')).toBe(false)
    expect(enumValueAt(['a', null], '1')).toBeNull()
  })

  it('当前值按严格比较找下标：字符串 "2" 不算数字 2', () => {
    expect(enumIndex([1, 2, 3], 2)).toBe(1)
    expect(enumIndex([1, 2, 3], '2')).toBe(-1)
    expect(enumIndex(['fast', 'slow'], 'slow')).toBe(1)
    expect(enumIndex([false, true], true)).toBe(1)
    expect(enumIndex([1, 2], undefined)).toBe(-1)
  })

  it('字符串原样当标签，其余按 JSON 显示', () => {
    expect(enumOptions(['a', 1, true, null]).map((o) => o.label)).toEqual(['a', '1', 'true', 'null'])
  })
})

describe('parseJsonDraft', () => {
  it('合法的解析出值，清空等于不设', () => {
    expect(parseJsonDraft('{"a": [1, 2]}')).toEqual({ ok: true, value: { a: [1, 2] } })
    expect(parseJsonDraft('   ')).toEqual({ ok: true, value: undefined })
  })

  it('不合法的报错，不给值（调用方据此保留原文、拦住保存）', () => {
    expect(parseJsonDraft('{"a": ')).toEqual({ ok: false, error: '不是合法的 JSON' })
  })
})
