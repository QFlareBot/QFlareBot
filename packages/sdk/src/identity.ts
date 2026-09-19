/** 头像规格：QQ 官方头像 CDN 支持 40 / 100 / 140 / 640 四档 */
export type AvatarSize = 40 | 100 | 140 | 640

/**
 * QQ 官方头像 CDN 直链：`https://thirdqq.qlogo.cn/qqapp/{botId}/{openid}/{size}`。
 * 纯字符串拼接，不发请求、无缓存；botId 或 openid 为空时返回空串。
 * 会话里的当前用户直接用 `session.avatarUrl`（640 规格），其他尺寸或离线 openid 用本函数。
 */
export function qqAvatar(botId: string, openid: string, size: AvatarSize = 640): string {
  if (!botId || !openid) return ''
  return `https://thirdqq.qlogo.cn/qqapp/${botId}/${openid}/${size}`
}

/**
 * 拼一条 @ 提及文本（`<@{openid}>`），放进 text 或 markdown content 即可。
 * 频道的数字 id 与群/单聊的 openid 都是按这个形状下发的；openid 为空时返回空串。
 */
export function qqAt(openid: string): string {
  return openid ? `<@${openid}>` : ''
}
