import { describe, expect, it } from 'vitest'
import { validateConfig } from './configSchema.js'

const schema = {
  type: 'object',
  properties: {
    greeting: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 10 },
    ratio: { type: 'number' },
    enabled: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string' } },
    mode: { enum: ['fast', 'slow'] },
    nested: { type: 'object' },
  },
  required: ['greeting'],
}

const ok = { greeting: '你好' }

describe('validateConfig', () => {
  it('没有 schema 或没有 properties 时一律放行', () => {
    expect(validateConfig(undefined, { anything: 1 })).toEqual([])
    expect(validateConfig({ type: 'object' }, { anything: 1 })).toEqual([])
  })

  it('合法配置无错误', () => {
    const value = { greeting: '你好', limit: 5, ratio: 1.5, enabled: true, tags: ['a'], mode: 'fast' }
    expect(validateConfig(schema, value)).toEqual([])
  })

  it('缺 required 字段', () => {
    expect(validateConfig(schema, {})).toEqual([{ path: 'greeting', message: '必填' }])
  })

  it('类型不符——这正是面板此前会静默存进去的情况', () => {
    expect(validateConfig(schema, { greeting: 12345 })).toEqual([
      { path: 'greeting', message: '应为字符串，实际是数字' },
    ])
  })

  it('integer 拒绝小数，number 接受', () => {
    expect(validateConfig(schema, { ...ok, limit: 1.5 })).toEqual([{ path: 'limit', message: '应为整数' }])
    expect(validateConfig(schema, { ...ok, ratio: 1.5 })).toEqual([])
  })

  it('数值上下界', () => {
    expect(validateConfig(schema, { ...ok, limit: 0 })).toEqual([{ path: 'limit', message: '不能小于 1' }])
    expect(validateConfig(schema, { ...ok, limit: 99 })).toEqual([{ path: 'limit', message: '不能大于 10' }])
  })

  it('字符串长度', () => {
    expect(validateConfig(schema, { greeting: '' })).toEqual([{ path: 'greeting', message: '至少 1 个字符' }])
  })

  it('string[] 逐项校验', () => {
    expect(validateConfig(schema, { ...ok, tags: 'a' })).toEqual([{ path: 'tags', message: '应为数组，实际是字符串' }])
    expect(validateConfig(schema, { ...ok, tags: ['a', 2] })).toEqual([
      { path: 'tags', message: '每一项都应为字符串' },
    ])
  })

  it('enum 限定取值', () => {
    expect(validateConfig(schema, { ...ok, mode: 'turbo' })).toEqual([
      { path: 'mode', message: '只能是 "fast" / "slow" 之一' },
    ])
  })

  it('嵌套对象与未声明的键放行：面板对它们本来就退化成 JSON 文本框', () => {
    expect(validateConfig(schema, { ...ok, nested: { any: [1, 2] }, extra: '插件自己存的' })).toEqual([])
  })

  it('配置整体不是对象', () => {
    expect(validateConfig(schema, 'nope')).toEqual([{ path: '', message: '配置应为对象，实际是字符串' }])
  })

  it('多个字段各报各的', () => {
    const errors = validateConfig(schema, { limit: 'x', enabled: 1 })
    expect(errors.map((e) => e.path).sort()).toEqual(['enabled', 'greeting', 'limit'])
  })
})
