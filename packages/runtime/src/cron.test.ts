/**
 * cron 匹配照标准 Vixie cron：星期 0/7 都是周日、月和星期认英文缩写、日和星期都受限时按 OR。
 * 实现在 @qqbot/sdk/cron，这里测运行时实际取用的 ./cron.js。时区固定 UTC。
 */
import { describe, expect, it } from 'vitest'
import { cronError, cronMatches } from './cron.js'

/** 2026-09 的某天 09:30 UTC。9/1 周二，9/18 周五，9/20 周日，9/21 周一 */
const sep = (day: number, hour = 9, minute = 30) => new Date(Date.UTC(2026, 8, day, hour, minute))
const TUE_1 = sep(1)
const FRI_18 = sep(18)
const SAT_19 = sep(19)
const SUN_20 = sep(20)
const MON_21 = sep(21)

describe('星期：0 和 7 都是周日', () => {
  it('单独写 7 是周日', () => {
    expect(cronMatches('30 9 * * 7', SUN_20)).toBe(true)
    expect(cronMatches('30 9 * * 0', SUN_20)).toBe(true)
    expect(cronMatches('30 9 * * 7', MON_21)).toBe(false)
  })

  it('带 7 的区间按值处理（以前把 7 换成 0，1-7 / 5-7 永不触发、0-7 只剩周日）', () => {
    for (const d of [MON_21, FRI_18, SAT_19, SUN_20]) expect(cronMatches('30 9 * * 1-7', d)).toBe(true)
    for (const d of [MON_21, FRI_18, SAT_19, SUN_20]) expect(cronMatches('30 9 * * 0-7', d)).toBe(true)
    expect(cronMatches('30 9 * * 5-7', FRI_18)).toBe(true)
    expect(cronMatches('30 9 * * 5-7', SUN_20)).toBe(true)
    expect(cronMatches('30 9 * * 5-7', MON_21)).toBe(false)
    expect(cronMatches('30 9 * * 6-7', FRI_18)).toBe(false)
  })

  it('星期段的步进从区间起点数', () => {
    // 1-7/2 = 一三五日
    expect(cronMatches('30 9 * * 1-7/2', SUN_20)).toBe(true)
    expect(cronMatches('30 9 * * 1-7/2', FRI_18)).toBe(true)
    expect(cronMatches('30 9 * * 1-7/2', SAT_19)).toBe(false)
  })
})

describe('英文缩写', () => {
  it('星期 SUN-SAT、月份 JAN-DEC，不分大小写，区间和列表里都能用', () => {
    expect(cronMatches('30 9 * * MON-FRI', FRI_18)).toBe(true)
    expect(cronMatches('30 9 * * mon-fri', SUN_20)).toBe(false)
    expect(cronMatches('30 9 * * Fri,SAT', SAT_19)).toBe(true)
    expect(cronMatches('30 9 * * sun', SUN_20)).toBe(true)
    expect(cronMatches('30 9 * SEP *', FRI_18)).toBe(true)
    expect(cronMatches('30 9 * jan-mar *', FRI_18)).toBe(false)
    expect(cronMatches('30 9 * AUG-DEC/2 *', FRI_18)).toBe(false) // 八、十、十二月
    expect(cronMatches('30 9 * JUL-DEC/2 *', FRI_18)).toBe(true) // 七、九、十一月
  })

  it('只有月和星期认缩写', () => {
    expect(cronError('0 9 MON * *')).toMatch(/第 3 段（日）「MON」不是合法的值/)
  })
})

describe('日和星期同时受限时按 OR', () => {
  it('两段都受限：任一命中就算', () => {
    expect(cronMatches('30 9 1 * MON', TUE_1)).toBe(true) // 1 号，虽然是周二
    expect(cronMatches('30 9 1 * MON', MON_21)).toBe(true) // 周一，虽然不是 1 号
    expect(cronMatches('30 9 1 * MON', FRI_18)).toBe(false)
    // 1-31 虽然覆盖全月，但不是 *，照样算受限
    expect(cronMatches('30 9 1-31 * MON', FRI_18)).toBe(true)
  })

  it('有一段以 * 开头：两段都得命中', () => {
    expect(cronMatches('30 9 * * MON', TUE_1)).toBe(false)
    expect(cronMatches('30 9 1 * *', MON_21)).toBe(false)
    // Vixie 只看首字符，*/2 也算 *：21 号周一两边都中，28 号周一日那段不中
    expect(cronMatches('30 9 */2 * MON', MON_21)).toBe(true)
    expect(cronMatches('30 9 */2 * MON', sep(28))).toBe(false)
    expect(cronMatches('30 9 1 * */1', MON_21)).toBe(false)
  })
})

describe('原有写法照旧', () => {
  it('*、区间、步进、列表、a/n', () => {
    expect(cronMatches('30 9 * * *', FRI_18)).toBe(true)
    expect(cronMatches('*/15 * * * *', FRI_18)).toBe(true)
    expect(cronMatches('0-29/10 9-10 * * 1-5', FRI_18)).toBe(false)
    expect(cronMatches('30 9 18 9 5', FRI_18)).toBe(true)
    expect(cronMatches('30 9 * * 0,6', FRI_18)).toBe(false)
    // a/n 是从 a 到上限每 n 个：5,20,35,50
    expect(cronMatches('5/15 * * * *', sep(18, 9, 20))).toBe(true)
    expect(cronMatches('5/15 * * * *', FRI_18)).toBe(false)
    expect(cronMatches('00 09 * * *', FRI_18)).toBe(false)
    expect(cronMatches('30 09 * * *', FRI_18)).toBe(true)
  })

  it('按 UTC 判断', () => {
    // 北京时间 17:30 = UTC 9:30
    expect(cronMatches('30 17 * * *', FRI_18)).toBe(false)
    expect(cronMatches('30 9 * * *', FRI_18)).toBe(true)
  })
})

describe('cronError', () => {
  it('合法的返回 null', () => {
    for (const expr of ['* * * * *', '0 9 * * *', '*/15 * * * *', '0 9 * * MON-FRI', '0 0 1 JAN *', '0 0 * * 7', ' 0  1 * * 1-7 ']) {
      expect(cronError(expr), expr).toBeNull()
    }
  })

  it('指出哪一段、哪一项错了', () => {
    expect(cronError('')).toMatch(/空/)
    expect(cronError('bad')).toMatch(/要 5 段.*实际是 1 段/)
    expect(cronError('0 9 * * * *')).toMatch(/实际是 6 段/)
    expect(cronError('60 * * * *')).toMatch(/第 1 段（分）「60」超出范围 0-59/)
    expect(cronError('0 24 * * *')).toMatch(/第 2 段（时）「24」超出范围 0-23/)
    expect(cronError('0 9 0 * *')).toMatch(/第 3 段（日）「0」超出范围 1-31/)
    expect(cronError('0 9 * 13 *')).toMatch(/第 4 段（月）「13」超出范围 1-12/)
    expect(cronError('0 9 * * 8')).toMatch(/第 5 段（星期）「8」超出范围 0-7/)
    expect(cronError('0 9 * * FUN')).toMatch(/「FUN」不是合法的值，只能写数字或 SUN-SAT/)
    expect(cronError('0 9 * * MON-')).toMatch(/第 5 段（星期）.*不是合法的值/)
    expect(cronError('*/0 * * * *')).toMatch(/步进要是正整数/)
    expect(cronError('*/x * * * *')).toMatch(/步进要是正整数/)
    expect(cronError('1/2/3 * * * *')).toMatch(/\/ 多了/)
    expect(cronError('1-2-3 * * * *')).toMatch(/不是合法的区间/)
    expect(cronError('1,,2 * * * *')).toMatch(/空项/)
    expect(cronError('0 9 * * 5-1')).toMatch(/区间「5-1」的起点比终点大/)
    expect(cronError('0 9 L * *')).toMatch(/「L」不是合法的值/)
    expect(cronError('0 9 ? * *')).toMatch(/「\?」不是合法的值/)
  })

  it('不合法的表达式一次都不触发，哪怕其中一部分写对了', () => {
    expect(cronMatches('bad', FRI_18)).toBe(false)
    expect(cronMatches('30,60 9 * * *', FRI_18)).toBe(false)
    expect(cronMatches('30 9 * * 5,', FRI_18)).toBe(false)
  })
})
