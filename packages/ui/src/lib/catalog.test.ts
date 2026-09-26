import { describe, expect, it } from 'vitest'
import { batchItemOf, dependsCoveredByBatch, installOrder, installUrlOf, type BatchItem } from './catalog.js'

const item = (name: string, depends: string[] = [], services: string[] = []): BatchItem =>
  batchItemOf({ name, repo: `me/qflarebot-plugin-${name}`, depends, services })

describe('installOrder', () => {
  it('提供服务的排在依赖它的前面', () => {
    const order = installOrder([item('poster', ['render']), item('render-kit', [], ['render']), item('solo')], new Set())
    expect(order.map((i) => i.name)).toEqual(['render-kit', 'solo', 'poster'])
  })

  it('依赖键与插件同名也算提供', () => {
    const order = installOrder([item('b', ['a']), item('a')], new Set())
    expect(order.map((i) => i.name)).toEqual(['a', 'b'])
  })

  it('已装插件提供的不用等', () => {
    const order = installOrder([item('poster', ['t2i']), item('solo')], new Set(['t2i']))
    expect(order.map((i) => i.name)).toEqual(['poster', 'solo'])
  })

  it('成环或谁都不提供的按原顺序排在最后', () => {
    const order = installOrder([item('x', ['y']), item('lonely', ['nobody']), item('y', ['x']), item('ok')], new Set())
    expect(order.map((i) => i.name)).toEqual(['ok', 'x', 'lonely', 'y'])
  })
})

describe('dependsCoveredByBatch', () => {
  const batch = [item('poster', ['render', 't2i']), item('render-kit', [], ['render'])]

  it('缺的由同一批其他插件或已装插件提供', () => {
    expect(dependsCoveredByBatch(batch[0]!, batch, new Set(['t2i']))).toBe(true)
  })

  it('有一个没人提供就不算', () => {
    expect(dependsCoveredByBatch(batch[0]!, batch, new Set())).toBe(false)
  })

  it('自己提供的不算，没有 depends 也不算', () => {
    expect(dependsCoveredByBatch(item('self', ['self-svc'], ['self-svc']), [item('self', ['self-svc'], ['self-svc'])], new Set())).toBe(false)
    expect(dependsCoveredByBatch(item('solo'), [item('solo')], new Set())).toBe(false)
  })
})

describe('installUrlOf', () => {
  it('优先用索引给的地址，老索引按 repo 拼', () => {
    expect(installUrlOf({ name: 'a', repo: 'me/x', installUrl: 'https://github.com/me/x/tree/main/p' })).toBe('https://github.com/me/x/tree/main/p')
    expect(installUrlOf({ name: 'a', repo: 'me/x' })).toBe('https://github.com/me/x')
    expect(installUrlOf({ name: 'a', repo: 'me/x', subdir: 'p' })).toBe('https://github.com/me/x/tree/HEAD/p')
  })
})
