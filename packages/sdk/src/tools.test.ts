import { describe, expect, it } from 'vitest'
import { definePlugin, extractManifest, validateManifest, validateToolValue } from './index.js'

const spec = {
  description: '查询天气',
  permission: 'member' as const,
  sideEffect: 'none' as const,
  inputSchema: {
    type: 'object',
    required: ['city'],
    additionalProperties: false,
    properties: { city: { type: 'string', minLength: 1 } },
  },
  handler: async () => ({ status: 'success' as const, output: { temperature: 21 } }),
}

describe('统一工具声明', () => {
  it('清单提取工具元数据，执行函数留在插件里；旧清单不新增空字段', () => {
    const manifest = extractManifest(
      definePlugin({ name: 'weather', version: '1.0.0', tools: { query: spec } }),
    )
    expect(manifest.tools?.[0]).toMatchObject({ name: 'query', permission: 'member' })
    expect(JSON.stringify(manifest)).not.toContain('handler')
    expect(validateManifest(manifest)).toEqual([])
    expect(extractManifest(definePlugin({ name: 'old', version: '1.0.0' })).tools).toBeUndefined()
  })

  it('旧 API 版本、保留服务名和不支持的 Schema 都在构建时拒绝', () => {
    const manifest = extractManifest(
      definePlugin({
        name: 'bad',
        version: '1.0.0',
        apiVersion: 4,
        services: { 'core.tools': () => ({}) },
        tools: { query: { ...spec, inputSchema: { type: 'object', $ref: '#/other' } } },
      }),
    )
    const errors = validateManifest(manifest).join('\n')
    expect(errors).toContain('apiVersion')
    expect(errors).toContain('保留服务名')
    expect(errors).toContain('$ref')
  })

  it('校验嵌套参数、额外参数与组合条件，不隐式转换类型', () => {
    expect(validateToolValue(spec.inputSchema, { city: '上海' })).toBeNull()
    expect(validateToolValue(spec.inputSchema, { city: 1 })).toContain('类型')
    expect(validateToolValue(spec.inputSchema, { city: '上海', actorRole: 'admin' })).toContain(
      '额外参数',
    )
    expect(
      validateToolValue(
        {
          type: 'array',
          items: {
            type: 'object',
            required: ['x'],
            properties: { x: { type: 'integer', minimum: 1 } },
          },
        },
        [{ x: 0 }],
      ),
    ).toContain('[0].x')
    expect(validateToolValue({ oneOf: [{ type: 'integer' }, { type: 'number' }] }, 1)).toContain(
      'oneOf',
    )
  })
})

it('服务绑定只提取目标和说明，转换函数不进入清单', () => {
  const manifest = extractManifest(
    definePlugin({
      name: 'weather',
      version: '1.0.0',
      services: { weather: () => ({ query: () => 21 }) },
      tools: {
        query: {
          description: '查询指定城市当前温度，返回摄氏度。',
          permission: 'member',
          sideEffect: 'none',
          inputSchema: spec.inputSchema,
          service: 'weather',
          method: 'query',
          mapInput: ({ input }) => [input],
          mapOutput: output => ({ status: 'success', output }),
        },
      },
    }),
  )

  expect(validateManifest(manifest)).toEqual([])
  expect(manifest.tools?.[0]).toMatchObject({ service: 'weather', method: 'query' })
  expect(JSON.stringify(manifest)).not.toMatch(/mapInput|mapOutput|handler/)
  manifest.tools![0]!.service = 'another-provider'
  expect(validateManifest(manifest).join()).toContain('本插件声明的服务')
  manifest.tools![0]!.method = 'constructor'
  expect(validateManifest(manifest).join()).toContain('公开方法名')
})
