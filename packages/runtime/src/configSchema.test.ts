import { describe, expect, it } from 'vitest'
import { validateConfig, withConfigDefaults } from './configSchema.js'

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

  it('没声明 properties 的对象、未声明的键放行：插件可能自己存额外状态', () => {
    expect(validateConfig(schema, { ...ok, nested: { any: [1, 2] }, extra: '插件自己存的' })).toEqual([])
  })

  it('声明成对象的字段不能是别的类型', () => {
    expect(validateConfig(schema, { ...ok, nested: [1] })).toEqual([{ path: 'nested', message: '应为对象，实际是数组' }])
  })

  it('配置整体不是对象', () => {
    expect(validateConfig(schema, 'nope')).toEqual([{ path: '', message: '配置应为对象，实际是字符串' }])
  })

  it('多个字段各报各的', () => {
    const errors = validateConfig(schema, { limit: 'x', enabled: 1 })
    expect(errors.map((e) => e.path).sort()).toEqual(['enabled', 'greeting', 'limit'])
  })
})

describe('validateConfig：嵌套结构，错误路径用点连', () => {
  const nested = {
    type: 'object',
    properties: {
      llm: {
        type: 'object',
        properties: { model: { type: 'string', minLength: 1 }, temperature: { type: 'number', maximum: 2 } },
        required: ['model'],
      },
      providers: {
        type: 'array',
        items: { type: 'object', properties: { name: { type: 'string' }, api_key: { type: 'string', writeOnly: true } }, required: ['name'] },
      },
      aliases: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } },
      level: { oneOf: [{ const: 1, title: '低' }, { const: 2, title: '高' }] },
      ports: { type: 'array', items: { type: 'integer' } },
    },
  }

  it('合法配置无错误', () => {
    const value = { llm: { model: 'x', temperature: 1 }, providers: [{ name: 'a', api_key: 'k' }], aliases: { a: 1 }, level: 2, ports: [80] }
    expect(validateConfig(nested, value)).toEqual([])
  })

  it('嵌套对象的 required 与字段类型', () => {
    expect(validateConfig(nested, { llm: { temperature: 3 } })).toEqual([
      { path: 'llm.model', message: '必填' },
      { path: 'llm.temperature', message: '不能大于 2' },
    ])
  })

  it('对象数组逐项查，路径带下标', () => {
    expect(validateConfig(nested, { providers: [{ name: 'a' }, { api_key: 1 }] })).toEqual([
      { path: 'providers.1.name', message: '必填' },
      { path: 'providers.1.api_key', message: '应为字符串，实际是数字' },
    ])
  })

  it('additionalProperties：每个值按它的 schema 查', () => {
    expect(validateConfig(nested, { aliases: { a: 1, b: -1 } })).toEqual([{ path: 'aliases.b', message: '不能小于 0' }])
  })

  it('oneOf 常量只认列出的值', () => {
    expect(validateConfig(nested, { level: 3 })).toEqual([{ path: 'level', message: '只能是 1 / 2 之一' }])
  })

  it('标量数组的错误报在数组本身：面板上它是一个输入组件', () => {
    expect(validateConfig(nested, { ports: [80, 1.5] })).toEqual([{ path: 'ports', message: '每一项都应为整数' }])
  })
})

describe('withConfigDefaults', () => {
  const shaped = {
    type: 'object',
    properties: {
      llm: { type: 'object', properties: { model: { type: 'string' }, temperature: { type: 'number' } } },
      aliases: { type: 'object', additionalProperties: { type: 'string' } },
      tags: { type: 'array', items: { type: 'string' } },
    },
  }
  const defaults = { llm: { model: 'a', temperature: 0.7 }, aliases: { hi: '你好' }, tags: ['x'], limit: 3 }

  it('顶层逐项合并：保存过的盖在默认值上，没保存的回落默认', () => {
    expect(withConfigDefaults({ limit: 5 }, defaults, shaped)).toEqual({ ...defaults, limit: 5 })
  })

  it('固定形状的嵌套对象继续合并：升级给它加的字段，保存过配置的用户也拿得到默认值', () => {
    expect(withConfigDefaults({ llm: { model: 'b' } }, defaults, shaped)).toMatchObject({ llm: { model: 'b', temperature: 0.7 } })
  })

  it('键名不固定的对象与数组整个替换：用户删掉的项不会被默认值加回来', () => {
    const merged = withConfigDefaults({ aliases: {}, tags: [] }, defaults, shaped) as Record<string, unknown>
    expect(merged['aliases']).toEqual({})
    expect(merged['tags']).toEqual([])
  })

  it('没有 schema 时只合并顶层（与以前一样）', () => {
    expect(withConfigDefaults({ llm: { model: 'b' } }, defaults)).toMatchObject({ llm: { model: 'b' } })
    expect((withConfigDefaults({ llm: { model: 'b' } }, defaults) as { llm: object }).llm).toEqual({ model: 'b' })
  })

  it('两边不都是对象时原样返回保存的', () => {
    expect(withConfigDefaults(undefined, defaults, shaped)).toBeUndefined()
    expect(withConfigDefaults({ a: 1 }, undefined, shaped)).toEqual({ a: 1 })
  })
})
