import { describe, expect, it } from 'vitest'
import { generateWranglerConfig } from './wrangler.js'
import type { Projection } from './types.js'

/**
 * 卸载带 DO 的插件后，部署不能失败（Cloudflare 错误码 10064）。
 *
 * 平台要求显式声明「删除这个类」——声明式 exports 模型下的写法是一条墓碑。
 * 这份名单由 Worker 卸载时记进 D1，构建机随清单取回，这里验证它被正确转成墓碑。
 *
 * 最容易漏的是「卸载最后一个带 DO 的插件」那条分支：没有 live 类时
 * `generateWranglerConfig` 会走 else 分支，早退掉就一条墓碑都不会生成。
 */

function proj(retired?: Array<{ className: string; plugin: string }>): Projection {
  return {
    mainModule: 'index.js',
    modules: {},
    hash: 'abc',
    metadata: { main_module: 'index.js', compatibility_date: '2026-09-01', bindings: [], exports: {} } as never,
    integrity: { core: 'sha256-x', plugins: {} },
    ...(retired ? { retiredDoClasses: retired } : {}),
  }
}

const base = { name: 'qqbot', compatibility_date: '2026-09-01' }

describe('已卸载插件的 DO 墓碑', () => {
  it('卸载后没有 live 类时，仍然生成墓碑（这条分支以前会早退）', () => {
    const config = generateWranglerConfig({
      base,
      projection: proj([{ className: 'P_agent_Agent', plugin: 'agent' }]),
      mainPath: 'index.js',
    })
    expect(config.exports).toEqual({
      P_agent_Agent: { type: 'durable-object', state: 'deleted' },
    })
  })

  it('还有 live 类时，live 与墓碑共存', () => {
    const p = proj([{ className: 'P_agent_Agent', plugin: 'agent' }])
    p.metadata.exports = { P_game_Room: { type: 'durable-object', storage: 'sqlite' } }
    const config = generateWranglerConfig({ base, projection: p, mainPath: 'index.js' })
    expect(config.exports).toMatchObject({
      P_game_Room: { type: 'durable-object', storage: 'sqlite' },
      P_agent_Agent: { type: 'durable-object', state: 'deleted' },
    })
  })

  it('类又回来了（重装同名插件）：以 live 为准，不能同时声明删除', () => {
    const p = proj([{ className: 'P_agent_Agent', plugin: 'agent' }])
    p.metadata.exports = { P_agent_Agent: { type: 'durable-object', storage: 'sqlite' } }
    const config = generateWranglerConfig({ base, projection: p, mainPath: 'index.js' })
    expect(config.exports).toEqual({ P_agent_Agent: { type: 'durable-object', storage: 'sqlite' } })
  })

  it('没有退役名单时不写 exports（老部署行为不变）', () => {
    const config = generateWranglerConfig({ base, projection: proj(), mainPath: 'index.js' })
    expect(config.exports).toBeUndefined()
  })
})
