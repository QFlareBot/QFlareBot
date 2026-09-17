/**
 * 内嵌按键（消息按钮）。字段与 QQ OpenAPI `keyboard` 对象一一对应，
 * 另附一个极简 builder，插件可以直接写对象字面量，也可以用 builder。
 */

/** 0 灰色线框 · 1 蓝色线框 · 3 白底红字 · 4 蓝底白字 */
export type ButtonStyle = 0 | 1 | 3 | 4

/** 0 跳转链接/小程序 · 1 回调后台（触发 INTERACTION_CREATE） · 2 指令按钮（把 data 填入输入框） */
export type ButtonActionType = 0 | 1 | 2

/** 0 指定用户 · 1 仅管理员 · 2 所有人 */
export type ButtonPermissionType = 0 | 1 | 2

export interface ButtonPermission {
  type: ButtonPermissionType
  specify_user_ids?: string[]
  /** 仅频道 */
  specify_role_ids?: string[]
}

export interface ButtonModal {
  /** 非空则点击前弹确认框，≤40 字且不能含链接 */
  content: string
  confirm_text?: string
  cancel_text?: string
}

export interface ButtonAction {
  type: ButtonActionType
  permission?: ButtonPermission
  /** type 1/2 必填：回调数据或指令文本；type 0 为链接 */
  data?: string
  unsupport_tips?: string
  /** 指令按钮：点击后直接发送（仅单聊） */
  enter?: boolean
  /** 指令按钮：发送的指令是否引用本消息 */
  reply?: boolean
  /** 指令按钮：1 打开图片选择器（仅手机单聊），会覆盖 enter */
  anchor?: number
  modal?: ButtonModal
}

export interface ButtonRenderData {
  /** ≤10 字 */
  label: string
  visited_label?: string
  style?: ButtonStyle
}

export interface Button {
  /** 键盘内唯一；回调事件中以 button_id 返回 */
  id?: string
  render_data: ButtonRenderData
  action: ButtonAction
  /** 同组按钮任一被点击后其余置灰，仅回调按钮有效 */
  group_id?: string
}

export interface KeyboardRow {
  buttons: Button[]
}

export interface KeyboardContent {
  rows: KeyboardRow[]
}

/** 预设模板 id 与自定义 content 互斥 */
export type Keyboard = { id: string; content?: never } | { content: KeyboardContent; id?: never }

// ---------- builder ----------

interface ButtonOptions {
  id?: string
  visitedLabel?: string
  style?: ButtonStyle
  permission?: ButtonPermission
  modal?: string | ButtonModal
  groupId?: string
  unsupportTips?: string
}

function baseButton(label: string, action: ButtonAction, o: ButtonOptions): Button {
  const btn: Button = { render_data: { label }, action }
  if (o.id) btn.id = o.id
  if (o.visitedLabel) btn.render_data.visited_label = o.visitedLabel
  if (o.style !== undefined) btn.render_data.style = o.style
  if (o.groupId) btn.group_id = o.groupId
  action.permission = o.permission ?? { type: 2 }
  if (o.modal) action.modal = typeof o.modal === 'string' ? { content: o.modal } : o.modal
  if (o.unsupportTips) action.unsupport_tips = o.unsupportTips
  return btn
}

export const button = {
  /** 打开链接或小程序 */
  link(label: string, url: string, o: ButtonOptions = {}): Button {
    return baseButton(label, { type: 0, data: url }, o)
  },
  /** 回调后台：触发 INTERACTION_CREATE，插件用 `buttons` 匹配器接收 */
  callback(label: string, data: string, o: ButtonOptions = {}): Button {
    return baseButton(label, { type: 1, data }, o)
  },
  /** 把指令填入输入框；`enter` 为 true 时直接发送（仅单聊） */
  command(label: string, data: string, o: ButtonOptions & { enter?: boolean; reply?: boolean; anchor?: number } = {}): Button {
    const action: ButtonAction = { type: 2, data }
    if (o.enter !== undefined) action.enter = o.enter
    if (o.reply !== undefined) action.reply = o.reply
    if (o.anchor !== undefined) action.anchor = o.anchor
    return baseButton(label, action, o)
  },
}

/** `keyboard([[a, b], [c]])` 每个子数组为一行 */
export function keyboard(rows: Button[][]): Keyboard {
  return { content: { rows: rows.map((buttons) => ({ buttons })) } }
}

/** 使用平台预设的键盘模板 */
export function keyboardTemplate(id: string): Keyboard {
  return { id }
}
