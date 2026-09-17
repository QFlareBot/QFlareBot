/**
 * 事件名：带命名空间的稳定标识，插件只依赖这里的名字，不依赖 QQ 原始的 `t` 字段。
 * QQ 新增的事件类型会自动落到 `qq.raw.<t 小写>`，插件不必等框架发版即可监听。
 */

export type KnownEventName =
  // 消息
  | 'qq.group.at_message'
  | 'qq.group.message'
  | 'qq.c2c.message'
  | 'qq.guild.at_message'
  | 'qq.guild.message'
  | 'qq.guild.direct_message'
  // 群与好友关系
  | 'qq.group.robot_added'
  | 'qq.group.robot_removed'
  | 'qq.group.msg_reject'
  | 'qq.group.msg_receive'
  | 'qq.c2c.friend_added'
  | 'qq.c2c.friend_removed'
  | 'qq.c2c.msg_reject'
  | 'qq.c2c.msg_receive'
  // 交互
  | 'qq.interaction'

export type EventName = KnownEventName | `qq.raw.${string}`

/** QQ 原始事件类型（payload.t）→ 事件名 */
export const QQ_EVENT_MAP: Readonly<Record<string, KnownEventName>> = {
  GROUP_AT_MESSAGE_CREATE: 'qq.group.at_message',
  GROUP_MESSAGE_CREATE: 'qq.group.message',
  C2C_MESSAGE_CREATE: 'qq.c2c.message',
  AT_MESSAGE_CREATE: 'qq.guild.at_message',
  MESSAGE_CREATE: 'qq.guild.message',
  DIRECT_MESSAGE_CREATE: 'qq.guild.direct_message',
  GROUP_ADD_ROBOT: 'qq.group.robot_added',
  GROUP_DEL_ROBOT: 'qq.group.robot_removed',
  GROUP_MSG_REJECT: 'qq.group.msg_reject',
  GROUP_MSG_RECEIVE: 'qq.group.msg_receive',
  FRIEND_ADD: 'qq.c2c.friend_added',
  FRIEND_DEL: 'qq.c2c.friend_removed',
  C2C_MSG_REJECT: 'qq.c2c.msg_reject',
  C2C_MSG_RECEIVE: 'qq.c2c.msg_receive',
  INTERACTION_CREATE: 'qq.interaction',
}

/** 携带消息正文、可被命令/正则匹配的事件 */
export const MESSAGE_EVENTS: ReadonlySet<EventName> = new Set<EventName>([
  'qq.group.at_message',
  'qq.group.message',
  'qq.c2c.message',
  'qq.guild.at_message',
  'qq.guild.message',
  'qq.guild.direct_message',
])

export function toEventName(rawType: string): EventName {
  return QQ_EVENT_MAP[rawType] ?? `qq.raw.${rawType.toLowerCase()}`
}

export function isMessageEvent(event: EventName): boolean {
  return MESSAGE_EVENTS.has(event)
}
