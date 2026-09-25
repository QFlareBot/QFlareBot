/**
 * 插件 DO 类的基类。单独成文件是因为它必须 `import 'cloudflare:workers'`，
 * 而 `durable.ts` 里的 symbol 与类型会被 manifest.ts 引用、进而被 projector / plugin-cli
 * 这些跑在 Node 里的包打包——平台模块不能跟着被拖进去。
 */
import { DurableObject } from 'cloudflare:workers'
import { PLUGIN_DURABLE_BASE, PLUGIN_SCOPE, type DurableContext, type ScopedDurableObjectClass } from './durable.js'

/**
 * 插件 DO 类的基类。
 *
 * ```ts
 * export class Room extends PluginDurableObject {
 *   async join(userId: string) {
 *     await this.plugin.db.run('INSERT INTO {members} (id) VALUES (?)', userId)
 *     return this.members()
 *   }
 * }
 * ```
 *
 * 继承平台的 `DurableObject`，所以 RPC（`await stub.join(id)`）与 `fetch()` 两种写法都成立。
 * `this.ctx` 仍是 `DurableObjectState`（平台的命名，不动），`this.plugin` 是作用域上下文。
 */
export abstract class PluginDurableObject extends DurableObject<DurableContext> {
  static readonly [PLUGIN_DURABLE_BASE] = true

  constructor(state: DurableObjectState, env: unknown) {
    const scope = (new.target as unknown as ScopedDurableObjectClass)[PLUGIN_SCOPE]
    if (!scope) {
      throw new Error(
        `Durable Object ${new.target.name} 没有作用域工厂：它必须经由投影生成的入口导出（P_<插件名>_<类名>），` +
          '直接在 wrangler.jsonc 里手动导出是不行的——那样拿到的会是未加前缀的裸 env。',
      )
    }
    super(state, scope(env))
  }

  /** 本插件的作用域上下文；与 `this.env` 同一个对象，这个名字更好读 */
  protected get plugin(): DurableContext {
    return this.env
  }
}
