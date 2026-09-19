# 平台能力 → 插件契约 对照表

对照 [QQ 机器人 API v2](https://bot.q.qq.com/wiki/develop/api-v2/)（2026-09-16 版）梳理。"暴露方式"指插件在 `session` / `ctx.api` 上如何使用；标"raw"的表示暂无类型化封装，用 `ctx.api.raw(method, path, body)` 直调。

## 消息收发

| 平台能力 | 暴露方式 | 备注 |
| --- | --- | --- |
| 文本 `msg_type 0` | `session.reply('text')` / `{ text }` | |
| Markdown `msg_type 2` | `{ markdown: { content } }` | 模板 `customTemplateId` + `params` 已废弃但可传 |
| **内嵌按键 keyboard** | `{ text, keyboard }` 或 `{ markdown, keyboard }` | 平台要求挂在 markdown 上，只给 text 时自动升级；`keyboard()` / `button.*` builder 见 `@qqbot/sdk` |
| 富媒体 `msg_type 7`：图片 | `{ image: { url \| base64 } }` | |
| 富媒体：视频 / 语音 / 文件 | `{ media: { type: 'video' \| 'voice' \| 'file', url, filename } }` | 图 png/jpg、视频 mp4、语音 silk；软限 20–30MB |
| 分片上传大文件（upload_prepare / part_finish） | raw | 文件 >200MB 才需要 |
| 引用回复 `message_reference` | `{ quote: true }` 引用当前消息；`{ quote: refIndex }` 引用指定 | `session.refIndex` / `SendResult.refIndex` |
| 被动回复 `msg_id` + `msg_seq` | `session.reply()` | `msg_seq` 集中分配，默认上限 5 |
| **被动回复 `event_id`** | `session.reply()` | 对 `GROUP_ADD_ROBOT`、`INTERACTION_CREATE`、`*_MSG_RECEIVE`、`FRIEND_ADD` 自动改用 event_id，不消耗主动额度；`session.canReply` 可判断 |
| 主动消息 | `session.send(msg, target?)` / `ctx.api.sendMessage()` | 群聊需白名单；单聊有频控 |
| 互动召回 `is_wakeup` | `ctx.api.sendMessage(t, msg, { wakeup: true })` | 仅单聊 |
| 输入中状态 `input_notify` | `session.typing(seconds)` | 仅单聊，≤60s |
| **流式消息** | `const w = session.stream(); w.write(); w.end()` | 仅单聊；群聊自动退化为 end 时一次性回复 |
| 撤回 | `session.recall(id?)` / `ctx.api.recallMessage()` | 2 分钟内；群管理员可撤成员消息 |
| **用户头像**（官方 CDN 规范） | `session.avatarUrl`（640） / `qqAvatar(botId, openid, size)` | 纯拼接 `thirdqq.qlogo.cn/qqapp/{botId}/{openid}/{size}`（size 40/100/140/640），不发请求、无缓存 |
| **@ 提及**（拼接文本） | `qqAt(openid)` → `<@openid>` | 放进 text / markdown content 即可；`session.mentions` 反向读取消息里 @ 了谁 |
| **机器人自身资料** `/users/@me` | `session.botName` / `botAvatar`（随快照下发）或 `ctx.api.me()` 直调（`BotProfile`） | 快照方案运行时零 API，改资料后重新保存凭证即可刷新；`api.me()` 不缓存，频率插件自控 |
| Ark / Embed（频道） | raw | |
| 表情回应 / 置顶 / 公告（频道） | raw | |

## 事件

| 平台事件 | 事件名 | Session 字段 |
| --- | --- | --- |
| GROUP_AT_MESSAGE_CREATE / GROUP_MESSAGE_CREATE | `qq.group.at_message` / `qq.group.message` | content、attachments、refIndex、mentions、atMe、memberRole |
| C2C_MESSAGE_CREATE | `qq.c2c.message` | 同上 |
| AT_MESSAGE_CREATE / MESSAGE_CREATE / DIRECT_MESSAGE_CREATE | `qq.guild.*` | |
| GROUP_ADD_ROBOT / GROUP_DEL_ROBOT | `qq.group.robot_added` / `robot_removed` | canReply（event_id） |
| GROUP_MSG_RECEIVE / REJECT、C2C_MSG_RECEIVE / REJECT | `qq.group.msg_receive` … | |
| FRIEND_ADD / FRIEND_DEL | `qq.c2c.friend_added` / `friend_removed` | |
| **GROUP_MEMBER_ADD / REMOVE** | `qq.group.member_added` / `member_removed` | userId = member_openid |
| **GROUP_JOIN_REQUEST** | `qq.group.join_request` | `raw.join_request_id`；审批用 `ctx.api.group.reviewJoinRequest` |
| **INTERACTION_CREATE** | `qq.interaction` + `buttons` 匹配器 | `session.interaction`：type / buttonId / buttonData / featureId / feedback / ack() |
| SUBSCRIBE_MESSAGE_STATUS | `qq.subscribe_status` | `raw.result[]` |
| GUILD_* / CHANNEL_* | `qq.guild.created` … | |
| 未列出的新事件 | `qq.raw.<t 小写>` | 不必等框架发版 |

### 按键回调的处理规则

- `buttons: { <按键 id>: { dataPattern?, handler } }`，只对 `action.type = 1` 的按键触发。
- 处理器**返回数字**即作为回应平台的 code（0 成功 · 1 失败 · 2 频繁 · 3 重复 · 4 无权限 · 5 仅管理员）；也可以 `interaction.ack(code)` 手动回应。
- 未匹配到任何插件、或插件没返回也没 ack，运行时在分发结束后自动以 0 回应——客户端永远不会转圈到超时。
- 按键回调可以 `session.reply()`：走 event_id 被动回复。

## 群管理（`ctx.api.group`，机器人需为群管理员）

| 接口 | 方法 |
| --- | --- |
| 群信息 / 机器人群内状态 | `info(g)`（`GroupInfo`）/ `botState(g)` |
| **入群自动审批策略**（白名单号码自动过审；机器人 ≤20 个策略，需有群管理员身份才运行；2026-09 实测闭环） | `joinStrategies(cursor?)` / `createJoinStrategy()` / `updateJoinStrategy()` / `deleteJoinStrategy()` / `executeJoinStrategy()` / `updateJoinStrategyWhitelist()` | 创建时 `groupOpenids` 与 `groupIds` 二选一（≤100）；`isEnable` on/off；不传 `expireAt` 默认一年 |
| 成员列表（游标分页，每页 30） / 成员信息 | `members(g, cursor)` / `member(g, m)` |
| 批量移除（≤20，可同时拉黑） | `removeMembers(g, ids, { addToBlacklist })` |
| 黑名单查询 / 操作 | `blacklist(g)` / `updateBlacklist(g, 'add' \| 'del', ids)` |
| 禁言（≤20 人，≤30 天） / 禁言状态 | `mute(g, [{ op: 'add', memberOpenid, expireAt }])` / `muteState(g)` |
| 入群申请列表 / 审批 | `joinRequests(g)` / `reviewJoinRequest(g, m, { approve } \| { approve: false, reason, addToBlacklist }, joinRequestId)` |

成员列表、批量移除、黑名单三组接口平台标注"内邀接入中"，未开白名单会返回 11253。

## 机器人全局配置（不属于单个插件，面板管理）

机器人的"外观"类配置改一次全局生效，由运营者在面板操作，不走插件契约（避免多个插件互相覆盖）。字段形状已对照官方文档，并于 2026-09 用真实机器人实测核对（探测工具：`scripts/probe-qq-api.mjs --from-kv`）。

| 能力 | QQ 端点 | 管理 API | 面板入口 |
| --- | --- | --- | --- |
| **指令面板**（用户点机器人看到的可点指令列表；scope=c2c/group/channel/dm；单面板 ≤20 项、机器人 ≤20 个面板；创建 10 QPM） | `GET/POST /v2/panels`、`DELETE /v2/panels/{panel_id}` | `GET/POST /admin/qq/panels`、`DELETE /admin/qq/panels/:panelId` | 设置 → QQ 指令面板：从已启用插件的命令一键生成请求体，声明了 `permission` 的命令自动带 `only_admin: true` |
| **分享/邀请链接**（点击直达机器人会话；请求体可为空，响应 `{ retcode, msg, data: { url } }`） | `/v2/generate_url_link` | `POST /admin/qq/url-link` | 设置 → 分享链接 |
| **自定义菜单**（仅单聊，全局一份；`menu.items` ≤10：switch/send_message/link/menu，子菜单 ≤5，PUT 5 QPM） | `GET/PUT /v2/menu` | `GET` / `PUT /admin/qq/menu` | 设置 → 自定义菜单（查看回填 + JSON 编辑保存） |
| 频道 API 权限申请 | — | 暂 raw | — |

指令面板创建请求体（官方 schema 摘录）：`{ scope, target_type?, group_openids?/user_openids?, panel: { items: [{ type: 'command'|'link', name, desc, only_admin?, link? }], remark?, version? } }` → 响应 `{ panel_id }`。`target_type=specific`（仅 c2c/group）配合 openid 列表可按群/用户定点生效。列表查询响应 `{ records: PanelRecord[], next_cursor, is_end }`。`items[].name` ≤14 字符、`desc` ≤30 字符。

## 错误语义

非 2xx 统一抛 `QQApiError`（结果型方法转为 `SendResult.error`，不再抛）。message 由 `describeApiError` 生成：平台 message 优先，附加已收录错误码/状态码的中文说明与错误码原值（如 `主动消息失败, 无权限（错误码 40034）`）。`err.code` / `err.traceId` / `err.body` 可取原始信息；已知码表在 `@qqbot/api` 的 `errors.ts`，遇到新错误码欢迎补录。

## 未验证项

- `file_data`（base64 直传）在原型中实测可用，但当前文档只列 `url` 与分片上传；大文件请用 `url`。
- `api.bot.qq.com` 为文档统一域名（2026-08-10 起），已确认与 `api.sgroup.qq.com` 同网关；如需回退可传 `baseUrl`。
- 群管理接口按文档字段实现，未在有管理员权限的群里实测。
- 群消息 `author.member_role` 已透传到 `session.memberRole`，但按键回调（INTERACTION_CREATE）不带群角色——`group_admin` 门槛的按钮回调验不了，因此按钮回调暂不鉴权。
- 入群自动审批策略已于 2026-09 实测完整闭环（创建关闭态策略 → 列表 → 白名单 → 删除，线上状态已还原）；自定义菜单的 PUT 已接入（schema 与 GET 同源），未单独线上回写验证。
