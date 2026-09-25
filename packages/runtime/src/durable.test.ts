import { PLUGIN_SCOPE, PluginDurableObject, type ScopedDurableObjectClass } from '@qqbot/sdk'
import { describe, expect, it } from 'vitest'
import { createDurableContext, createScopedDurable, durableScope } from './durable.js'
import { createEnv } from './testing/mocks.js'

/** 假命名空间：只记下拿到的 id，够验证 idFromName 与绑定选取 */
function fakeNamespace(label: string) {
  const asked: string[] = []
  return {
    asked,
    ns: {
      idFromName(name: string) {
        asked.push(name)
        return { toString: () => `${label}:${name}` }
      },
      get(id: { toString(): string }) {
        return { stub: id.toString() }
      },
    },
  }
}

describe('createScopedDurable', () => {
  it('按名字取实例：命名空间按 P_<插件>_<类> 选取，实例名原样喂给 idFromName', () => {
    const { ns, asked } = fakeNamespace('room')
    const env = createEnv({ P_game_Room: ns } as never)
    const durable = createScopedDurable(env, 'game', ['Room'])

    expect(durable.get('Room', 'group-1')).toEqual({ stub: 'room:group-1' })
    // 命名空间本身已经是「插件 + 类」粒度，实例名不该再被加前缀
    expect(asked).toEqual(['group-1'])
  })

  it('取没声明过的类抛错，不让插件够到别人的 DO', () => {
    const env = createEnv({ P_other_Secret: fakeNamespace('x').ns } as never)
    const durable = createScopedDurable(env, 'game', ['Room'])
    expect(() => durable.get('Secret', 'a')).toThrow('没有声明 Durable Object 类 Secret')
  })

  it('声明了但绑定不存在时抛可读错误，而不是回一个 undefined 让人去猜', () => {
    const durable = createScopedDurable(createEnv(), 'game', ['Room'])
    expect(() => durable.get('Room', 'a')).toThrow('P_game_Room 不存在')
  })

  it('namespace() 同样只放行已声明的类', () => {
    const { ns } = fakeNamespace('room')
    const env = createEnv({ P_game_Room: ns } as never)
    const durable = createScopedDurable(env, 'game', ['Room'])
    expect(durable.namespace('Room')).toBe(ns)
    expect(() => durable.namespace('Nope')).toThrow('没有声明')
  })
})

describe('createDurableContext', () => {
  it('存储三件套带的前缀与 ctx 侧一致——卸载按前缀清理才清得干净', async () => {
    const env = createEnv()
    const dctx = createDurableContext(env, 'game')

    await dctx.kv.put('seat', '1')
    expect(await env.KV.get('p:game:seat')).toBe('1')
    expect(dctx.db.table('members')).toBe('p_game_members')
    expect(dctx.plugin.name).toBe('game')
  })
})

describe('durableScope + PluginDurableObject', () => {
  class Room extends PluginDurableObject {
    seat(): string {
      return this.env.plugin.name
    }
  }

  it('挂上工厂之后，基类构造时把裸 env 换成作用域上下文', () => {
    const Scoped = durableScope(Room, 'game')
    expect((Scoped as unknown as ScopedDurableObjectClass)[PLUGIN_SCOPE]).toBeTypeOf('function')

    const env = createEnv()
    const room = new Scoped({} as DurableObjectState, env)
    // this.env 已经不是裸 env：拿不到 secret，存储也都是带前缀的
    expect(room.seat()).toBe('game')
    expect((room as unknown as { env: Record<string, unknown> }).env['BOT_SECRET']).toBeUndefined()
    expect(room.seat()).not.toBe(undefined)
  })

  it('没经过投影入口（工厂缺失）直接构造会抛错点名原因', () => {
    class Loose extends PluginDurableObject {}
    expect(() => new Loose({} as DurableObjectState, createEnv())).toThrow('没有作用域工厂')
  })
})
