/**
 * 机器人的公开地址（`ctx.publicUrl`）：插件拼自己路由的完整地址，交给 QQ 去拉图片时用。
 *
 * Worker 不知道自己「是哪个域名」——可能同时挂着 workers.dev 和好几个自定义域名——但知道这个请求是从哪个域名进来的。
 * QQ 推送事件请求的就是回调地址，正是 QQ 访问得到的那个，所以事件里直接用它；绑了几个域名也不影响。
 * 设置页填了就以填的为准（想让图片走另一个域名、或者定时任务里也要用）；定时任务没有请求，只有填了才有。
 *
 * 只认 https：QQ 不拉 http 的图片，本地 `wrangler dev` 的 http://localhost 给了插件也用不上。
 */
import type { Snapshot } from './types.js'

/** `https://域名[:端口]`，不带路径、查询与结尾斜杠；设置页保存时按这个校验 */
export function isHttpsOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('https://')) return false
  try {
    return new URL(value).origin === value
  } catch {
    return false
  }
}

/** 这次请求里插件拿到的公开地址；`requestOrigin` 是进来的请求的 origin，定时任务没有 */
export function publicUrlFor(snapshot: Snapshot, requestOrigin?: string): string | undefined {
  if (isHttpsOrigin(snapshot.publicUrl)) return snapshot.publicUrl
  return isHttpsOrigin(requestOrigin) ? requestOrigin : undefined
}
