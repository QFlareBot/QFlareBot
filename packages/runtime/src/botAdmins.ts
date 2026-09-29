import type { Snapshot } from './types.js'

/**
 * 快照里的 Bot 管理员名单，给 session.isBotAdmin 和 ctx.botAdmins 用。
 * 快照在 KV 里没有形状保证（整体 PUT 进来的），不是数组就当没设、非字符串和空串丢掉；
 * 返回冻结的副本：插件拿到的是它，改不动 isolate 里缓存着的快照
 */
export function botAdminsOf(snapshot: Snapshot): readonly string[] {
  const list = Array.isArray(snapshot.admins) ? snapshot.admins : []
  return Object.freeze(list.filter((id): id is string => typeof id === 'string' && id !== ''))
}
