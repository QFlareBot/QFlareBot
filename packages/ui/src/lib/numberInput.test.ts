import { describe, expect, it } from 'vitest'
import { parseNumber, stepBase, stepNumber } from './numberInput.js'

describe('parseNumber', () => {
  it('空着是不填', () => {
    expect(parseNumber('  ')).toEqual({ ok: true, value: undefined })
  })
  it('认小数、负数、科学计数法，也认全角数字和中文句号', () => {
    expect(parseNumber('-1.5')).toEqual({ ok: true, value: -1.5 })
    expect(parseNumber('.5')).toEqual({ ok: true, value: 0.5 })
    expect(parseNumber('1e3')).toEqual({ ok: true, value: 1000 })
    expect(parseNumber('１２。５')).toEqual({ ok: true, value: 12.5 })
    expect(parseNumber('－3')).toEqual({ ok: true, value: -3 })
  })
  it('不是数字、半截的都算错', () => {
    expect(parseNumber('abc').ok).toBe(false)
    expect(parseNumber('-').ok).toBe(false)
    expect(parseNumber('1,000').ok).toBe(false)
    expect(parseNumber('0x10').ok).toBe(false)
  })
  it('整数与范围', () => {
    expect(parseNumber('1.5', { integer: true })).toEqual({ ok: false, error: '请输入整数' })
    expect(parseNumber('-1', { min: 0 })).toEqual({ ok: false, error: '不能小于 0' })
    expect(parseNumber('11', { max: 10 })).toEqual({ ok: false, error: '不能大于 10' })
    expect(parseNumber('10', { min: 0, max: 10, integer: true })).toEqual({ ok: true, value: 10 })
  })
})

describe('stepNumber / stepBase', () => {
  it('按小数位取整，不出现浮点尾巴', () => {
    expect(stepNumber(0.1, 0.2)).toBe(0.3)
    expect(stepNumber(1.1, 1)).toBe(2.1)
  })
  it('夹在范围里', () => {
    expect(stepNumber(9, 5, { max: 10 })).toBe(10)
    expect(stepNumber(1, -5, { min: 0 })).toBe(0)
  })
  it('空着时从默认值或 0 开始，也夹在范围里', () => {
    expect(stepBase(undefined)).toBe(0)
    expect(stepBase(7)).toBe(7)
    expect(stepBase(undefined, { min: 3 })).toBe(3)
  })
})
