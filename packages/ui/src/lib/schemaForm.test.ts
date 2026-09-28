import { describe, expect, it } from 'vitest'
import type { JsonSchema } from '../api/types.js'
import {
  blankValue,
  constChoices,
  enumIndex,
  enumOptions,
  enumValueAt,
  fieldKind,
  fieldLabel,
  getOwn,
  initialValue,
  isSecretPlaceholder,
  joinId,
  joinPath,
  mapFromRows,
  mapValueSchema,
  moveItem,
  parseJsonDraft,
  removeAt,
  SECRET_PLACEHOLDER_PREFIX,
  setIn,
} from './schemaForm.js'

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

describe('oneOf / anyOf 的 const 下拉', () => {
  it('每项都有 const 才算，标签用 title，没有 title 用 String(const)', () => {
    expect(constChoices({ oneOf: [{ const: 1, title: '一' }, { const: 'b' }, { const: null }] })).toEqual({
      values: [1, 'b', null],
      labels: ['一', 'b', 'null'],
    })
    expect(constChoices({ anyOf: [{ const: true, title: '是' }] })).toEqual({ values: [true], labels: ['是'] })
    expect(constChoices({ oneOf: [{ const: 1 }, { type: 'string' }] })).toBeNull()
    expect(constChoices({ oneOf: [] })).toBeNull()
    expect(constChoices({ type: 'string' })).toBeNull()
  })

  it('按下标选回来的是 const 原值，不是字符串下标', () => {
    const c = constChoices({ oneOf: [{ const: 10 }, { const: 20 }] })!
    expect(enumValueAt(c.values, String(enumIndex(c.values, 20)))).toBe(20)
    expect(enumIndex(c.values, '20')).toBe(-1)
  })
})

describe('fieldKind', () => {
  const obj: JsonSchema = { type: 'object', properties: { a: { type: 'string' } } }
  it.each<[JsonSchema, string]>([
    [{ oneOf: [{ const: 1 }] }, 'const'],
    [{ type: 'string', enum: ['a'] }, 'enum'],
    [{ type: 'string', writeOnly: true }, 'secret'],
    [{ type: 'string', format: 'textarea' }, 'textarea'],
    [{ type: 'string' }, 'string'],
    [{ type: 'integer', minimum: 0 }, 'number'],
    [{ type: 'boolean' }, 'boolean'],
    [{ type: 'array', items: { type: 'string' } }, 'string[]'],
    [obj, 'object'],
    [{ properties: { a: { type: 'string' } } }, 'object'],
    [{ type: 'array', items: obj }, 'object[]'],
    [{ type: 'object', additionalProperties: { type: 'number' } }, 'map'],
    [{ type: 'object', additionalProperties: true }, 'map'],
    [{ type: 'object' }, 'json'],
    [{ type: 'array', items: { type: 'number' } }, 'json'],
    [{ type: 'array', items: { type: 'object' } }, 'json'],
    [{}, 'json'],
  ])('%j → %s', (s, kind) => {
    expect(fieldKind(s)).toBe(kind)
  })
})

describe('路径与 id', () => {
  it('点分拼接，数组下标从 0 起，顶层就是键名本身（与服务端错误的 path 对得上）', () => {
    expect(joinPath('', 'a')).toBe('a')
    expect(joinPath('a', 'b')).toBe('a.b')
    expect(joinPath(joinPath('items', 0), 'name')).toBe('items.0.name')
    expect(joinPath('map', '群 1')).toBe('map.群 1')
  })

  it('id 从路径派生，空白和点换掉（aria-describedby 按空白分隔多个 id）', () => {
    expect(joinId(joinId(joinId('cfg', 'a'), 0), 'name')).toBe('cfg-a-0-name')
    expect(joinId('cfg', 'a b.c')).toBe('cfg-a-b-c')
  })
})

describe('fieldLabel', () => {
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      rules: {
        type: 'array',
        title: '规则',
        items: { type: 'object', properties: { name: { type: 'string', title: '名称' }, tags: { type: 'object', additionalProperties: { type: 'object', properties: { on: { type: 'boolean', title: '开关' } } } } } },
      },
      plain: { type: 'object', properties: { x: { type: 'number' } } },
    },
  }
  it('没给 schema 原样返回', () => {
    expect(fieldLabel('a.b')).toBe('a.b')
    expect(fieldLabel('items.0.name')).toBe('items.0.name')
  })
  it('给了 schema 换成各级 title，数组下标换成第 n 项，映射的键原样', () => {
    expect(fieldLabel('rules.0.name', schema)).toBe('规则 › 第 1 项 › 名称')
    expect(fieldLabel('rules.2.tags.早安.on', schema)).toBe('规则 › 第 3 项 › tags › 早安 › 开关')
    expect(fieldLabel('plain.x', schema)).toBe('plain › x')
    expect(fieldLabel('rules', schema)).toBe('规则')
  })
  it('schema 里找不到的段原样保留', () => {
    expect(fieldLabel('nope.deeper', schema)).toBe('nope › deeper')
  })
})

describe('不可变更新', () => {
  it('setIn 按路径写入，沿途复制，原对象不动', () => {
    const src = { a: { b: 1, keep: [1] }, other: { x: 1 } }
    const next = setIn(src, ['a', 'b'], 2) as typeof src
    expect(next).toEqual({ a: { b: 2, keep: [1] }, other: { x: 1 } })
    expect(src.a.b).toBe(1)
    expect(next.a).not.toBe(src.a)
    expect(next.other).toBe(src.other)
    expect(next.a.keep).toBe(src.a.keep)
  })

  it('数组下标写入得到新数组；缺的层按下一段是数字还是字符串补', () => {
    const src = { items: [{ n: 'a' }, { n: 'b' }] }
    const next = setIn(src, ['items', 1, 'n'], 'c') as typeof src
    expect(next.items).toEqual([{ n: 'a' }, { n: 'c' }])
    expect(Array.isArray(next.items)).toBe(true)
    expect(src.items[1]!.n).toBe('b')
    expect(setIn(undefined, ['list', 0, 'k'], 1)).toEqual({ list: [{ k: 1 }] })
    expect(setIn({ a: 'not an object' }, ['a', 'b'], 1)).toEqual({ a: { b: 1 } })
  })

  it('对象上写 undefined 等于删掉这个键', () => {
    expect(setIn({ a: 1, b: 2 }, ['a'], undefined)).toEqual({ b: 2 })
    expect(Object.keys(setIn({ a: { n: 1 } }, ['a', 'n'], undefined) as object)).toEqual(['a'])
  })

  it('空路径直接替换', () => {
    expect(setIn({ a: 1 }, [], 5)).toBe(5)
  })

  it('键叫 constructor / toString 时不会读到原型上的函数', () => {
    expect(getOwn({}, 'constructor')).toBeUndefined()
    expect(getOwn({ toString: 'x' }, 'toString')).toBe('x')
    expect(getOwn(undefined, 'a')).toBeUndefined()
    expect(setIn({}, ['constructor', 'a'], 1)).toEqual({ constructor: { a: 1 } })
    expect(fieldLabel('toString', { type: 'object', properties: {} })).toBe('toString')
  })

  it('moveItem / removeAt 返回新数组，越界不动', () => {
    const list = ['a', 'b', 'c']
    expect(moveItem(list, 0, 1)).toEqual(['b', 'a', 'c'])
    expect(moveItem(list, 2, 1)).toEqual(['a', 'c', 'b'])
    expect(moveItem(list, 0, 3)).toEqual(['a', 'b', 'c'])
    expect(removeAt(list, 1)).toEqual(['a', 'c'])
    expect(list).toEqual(['a', 'b', 'c'])
  })
})

describe('新加一项的初始值', () => {
  it('带上声明的默认值，嵌套对象也带；默认值是复制出来的', () => {
    const shared = ['x']
    const s: JsonSchema = {
      type: 'object',
      properties: { on: { type: 'boolean', default: true }, name: { type: 'string' }, tags: { type: 'array', default: shared }, sub: { type: 'object', properties: { n: { type: 'number', default: 3 } } } },
    }
    const v = initialValue(s) as { tags: string[] }
    expect(v).toEqual({ on: true, tags: ['x'], sub: { n: 3 } })
    expect(v.tags).not.toBe(shared)
    expect(initialValue({ type: 'object', properties: { a: { type: 'string' } } })).toBeUndefined()
  })

  it('blankValue：没默认值时给这种类型的空值，数字这类留 undefined', () => {
    expect(blankValue({ type: 'string' })).toBe('')
    expect(blankValue({ type: 'boolean' })).toBe(false)
    expect(blankValue({ type: 'object', properties: { a: { type: 'string' } } })).toEqual({})
    expect(blankValue({ type: 'array', items: { type: 'string' } })).toEqual([])
    expect(blankValue({ type: 'number' })).toBeUndefined()
    expect(blankValue({ type: 'number', default: 5 })).toBe(5)
  })
})

describe('映射（键值对）', () => {
  it('按行拼成对象，键去掉首尾空白，保持行的顺序', () => {
    expect(mapFromRows([{ key: ' b ', value: 1 }, { key: 'a', value: 2 }])).toEqual({ value: { b: 1, a: 2 }, problems: [] })
  })

  it('键重复时每一行都报出来，调用方据此拦住保存', () => {
    const r = mapFromRows([
      { key: 'x', value: 1 },
      { key: 'y', value: 2 },
      { key: 'x ', value: 3 },
    ])
    expect(r.problems).toEqual([
      { row: 0, key: 'x', message: '键「x」重复了' },
      { row: 2, key: 'x', message: '键「x」重复了' },
    ])
  })

  it('键空着：值没动过的行当作没写完、忽略；动过就报错', () => {
    expect(mapFromRows([{ key: '', value: '', seed: '' }]).problems).toEqual([])
    expect(mapFromRows([{ key: '  ', value: true, seed: true }]).problems).toEqual([])
    expect(mapFromRows([{ key: '', value: 'hi', seed: '' }]).problems).toEqual([{ row: 0, key: '', message: '键不能为空' }])
  })

  it('有键没值会被 JSON 吞掉，报出来', () => {
    expect(mapFromRows([{ key: 'n', value: undefined }]).problems).toEqual([{ row: 0, key: 'n', message: '还没填值' }])
  })

  it('键叫 __proto__ 也是普通的键', () => {
    const { value } = mapFromRows([{ key: '__proto__', value: 1 }])
    expect(Object.keys(value)).toEqual(['__proto__'])
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
  })

  it('值的 schema：给了就用；true 时按字符串编辑，已有的非字符串值退回 JSON', () => {
    const vs: JsonSchema = { type: 'number' }
    expect(mapValueSchema({ additionalProperties: vs }, 'x')).toBe(vs)
    expect(mapValueSchema({ additionalProperties: true }, 'x')).toEqual({ type: 'string' })
    expect(mapValueSchema({ additionalProperties: true }, undefined)).toEqual({ type: 'string' })
    expect(fieldKind(mapValueSchema({ additionalProperties: true }, 3))).toBe('json')
  })
})

describe('密钥占位', () => {
  it('只认带前缀的字符串', () => {
    expect(SECRET_PLACEHOLDER_PREFIX).toBe('__qflare_secret__:')
    expect(isSecretPlaceholder('__qflare_secret__:/token')).toBe(true)
    expect(isSecretPlaceholder('__qflare_secret__:/accounts/0/key')).toBe(true)
    expect(isSecretPlaceholder('')).toBe(false)
    expect(isSecretPlaceholder('sk-123')).toBe(false)
    expect(isSecretPlaceholder('x__qflare_secret__:/token')).toBe(false)
    expect(isSecretPlaceholder(undefined)).toBe(false)
    expect(isSecretPlaceholder({ v: '__qflare_secret__:/a' })).toBe(false)
  })
})
