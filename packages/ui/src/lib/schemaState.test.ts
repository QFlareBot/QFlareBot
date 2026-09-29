import { describe, expect, it } from 'vitest'
import { fieldKind, multiChoices } from './schemaForm.js'
import { childDefault, isShown, sameValue } from './schemaState.js'

describe('sameValue', () => {
  it('对象不看键的顺序，undefined 的键等于没有', () => {
    expect(sameValue({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true)
    expect(sameValue({ a: 1, x: undefined }, { a: 1 })).toBe(true)
  })
  it('数组看顺序，类型不同不相等', () => {
    expect(sameValue([1, 2], [2, 1])).toBe(false)
    expect(sameValue([], {})).toBe(false)
    expect(sameValue(1, '1')).toBe(false)
    expect(sameValue(NaN, NaN)).toBe(true)
  })
})

describe('childDefault', () => {
  it('defaultConfig 里有这个键用它，没有才用 schema 的 default', () => {
    expect(childDefault({ a: 5 }, 'a', { default: 1 })).toBe(5)
    expect(childDefault({}, 'a', { default: 1 })).toBe(1)
    expect(childDefault(null, 'a', {})).toBeUndefined()
  })
})

describe('isShown', () => {
  const s = { 'x-showIf': { mode: 'custom', level: [1, 2] } }
  it('每条都满足才显示；数组表示任意一个', () => {
    expect(isShown(s, { mode: 'custom', level: 2 })).toBe(true)
    expect(isShown(s, { mode: 'custom', level: 3 })).toBe(false)
    expect(isShown(s, { mode: 'builtin', level: 1 })).toBe(false)
  })
  it('没写条件一直显示；同级值缺失当作 undefined', () => {
    expect(isShown({}, {})).toBe(true)
    expect(isShown({ 'x-showIf': { on: true } }, {})).toBe(false)
  })
})

describe('多选', () => {
  it('items 是 enum 或 const oneOf 的数组是 multi', () => {
    expect(fieldKind({ type: 'array', items: { type: 'string', enum: ['a', 'b'] } })).toBe('multi')
    expect(fieldKind({ type: 'array', items: { oneOf: [{ const: 1, title: '一' }] } })).toBe('multi')
    expect(fieldKind({ type: 'array', items: { type: 'string' } })).toBe('string[]')
  })
  it('标签：enum 用值本身，oneOf 用 title', () => {
    expect(multiChoices({ type: 'array', items: { enum: ['a', 2] } })).toEqual({ values: ['a', 2], labels: ['a', '2'] })
    expect(multiChoices({ type: 'array', items: { oneOf: [{ const: 1, title: '一' }] } })).toEqual({ values: [1], labels: ['一'] })
  })
})
