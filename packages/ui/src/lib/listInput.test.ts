import { describe, expect, it } from 'vitest'
import { cleanList, sameList, splitList } from './listInput.js'

describe('splitList', () => {
  it('line：只按换行拆，行内的空格、逗号保留', () => {
    expect(splitList('早上好, 朋友\n\n  晚安  \r\n')).toEqual(['早上好, 朋友', '晚安'])
  })
  it('any：换行、空格、中英文逗号都算分隔', () => {
    expect(splitList('A1 B2,C3，D4\nE5\t F6', 'any')).toEqual(['A1', 'B2', 'C3', 'D4', 'E5', 'F6'])
  })
  it('只有空白时是空数组', () => {
    expect(splitList('  \n ', 'any')).toEqual([])
  })
})

describe('cleanList / sameList', () => {
  it('去掉首尾空白与空行', () => {
    expect(cleanList([' a ', '', '  ', 'b'])).toEqual(['a', 'b'])
  })
  it('逐项比较', () => {
    expect(sameList(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(sameList(['a', 'b'], ['b', 'a'])).toBe(false)
    expect(sameList(['a'], ['a', 'b'])).toBe(false)
  })
})
