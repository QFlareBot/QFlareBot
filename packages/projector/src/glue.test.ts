import { describe, expect, it } from 'vitest'
import { makeDeployManifest, makePlugin } from './__fixtures__/manifest.js'
import { collectDurableObjects, doExportName, generateGlue } from './glue.js'

const HASH = 'abc123'.padEnd(64, '0')

describe('generateGlue', () => {
  const glue = generateGlue({ manifest: makeDeployManifest(), hash: HASH })

  it('导入 runtime 并默认导出 createRuntime 结果', () => {
    // 有 DO 时要多带一个 durableScope；没有 DO 的清单不该白白引它
    expect(glue).toContain("import { createRuntime, durableScope } from './runtime.js'")
    expect(glue).toContain('export default createRuntime({ plugins, projection: PROJECTION })')
  })

  it('插件通过动态 import 按需加载，并按 name 排序', () => {
    expect(glue).toContain("load: () => import('./plugins/foo.js')")
    expect(glue).toContain("load: () => import('./plugins/bar.js')")
    expect(glue.indexOf("import('./plugins/bar.js')")).toBeLessThan(glue.indexOf("import('./plugins/foo.js')"))
    // 没有 DO 的插件不能出现静态 import：求值失败只该影响它自己
    expect(glue).not.toMatch(/^import .* from '\.\/plugins\/bar\.js'/m)
  })

  it('DO 类经 durableScope 挂上作用域工厂再导出，而不是裸重导出', () => {
    // 裸重导出会让平台把未加前缀的 env 直接交给插件，DO 里建的数据框架清不掉
    expect(glue).toContain("import { Game as _do_P_foo_Game } from './plugins/foo.js'")
    expect(glue).toContain('export const P_foo_Game = durableScope(_do_P_foo_Game, "foo")')
    expect(glue).not.toContain("export { Game as P_foo_Game } from")
  })

  it('包含 PROJECTION 常量与 manifest JSON', () => {
    expect(glue).toContain(`const PROJECTION = "sha256-${HASH}"`)
    const foo = makeDeployManifest().plugins.find((p) => p.name === 'foo')
    expect(glue).toContain(`manifest: ${JSON.stringify(foo?.manifest)}`)
    expect(glue).not.toContain('"enabled"')
    expect(glue.startsWith('// 由 @qqbot/projector 生成')).toBe(true)
  })

  it('无 DO 时没有重导出行', () => {
    const manifest = makeDeployManifest()
    manifest.plugins = manifest.plugins.filter((p) => p.name === 'bar')
    const out = generateGlue({ manifest, hash: HASH })
    expect(out).not.toContain('durableScope')
    expect(out).toContain("import { createRuntime } from './runtime.js'")
    expect(out).toContain("import('./plugins/bar.js')")
  })

  it('生成结果是合法的 ES 模块语法', () => {
    // 用 Function 构造器无法解析 import/export，改用 dynamic import 的 data URL 校验语法
    const src = glue.replace(
      /from '\.\/[^']+'/g,
      "from 'data:text/javascript,export const createRuntime=()=>1;export const durableScope=(c)=>c;export class Game{}'",
    )
    return expect(import(`data:text/javascript,${encodeURIComponent(src)}`)).resolves.toBeDefined()
  })

  it('插件名重复或 DO 类名非法时抛错', () => {
    const dup = makeDeployManifest()
    dup.plugins.push(makePlugin('foo'))
    expect(() => generateGlue({ manifest: dup, hash: HASH })).toThrow('重复')

    const bad = makeDeployManifest()
    bad.plugins.push(makePlugin('baz', { manifest: { durableObjects: ['Not-Ident'] } }))
    expect(() => generateGlue({ manifest: bad, hash: HASH })).toThrow('非法')
  })
})

describe('doExportName / collectDurableObjects', () => {
  it('非字母数字替换为下划线', () => {
    expect(doExportName('my-plugin_x', 'Room')).toBe('P_my_plugin_x_Room')
  })

  it('按插件名、类名排序', () => {
    const list = collectDurableObjects([
      makePlugin('zeta', { manifest: { durableObjects: ['B', 'A'] } }),
      makePlugin('alpha', { manifest: { durableObjects: ['Room'] } }),
    ])
    expect(list.map((d) => d.exportName)).toEqual(['P_alpha_Room', 'P_zeta_A', 'P_zeta_B'])
  })

  it('导出名冲突时抛错', () => {
    expect(() =>
      collectDurableObjects([
        makePlugin('a-b', { manifest: { durableObjects: ['X'] } }),
        makePlugin('a_b', { manifest: { durableObjects: ['X'] } }),
      ]),
    ).toThrow('冲突')
  })
})
