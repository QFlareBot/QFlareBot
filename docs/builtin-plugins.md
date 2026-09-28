---
description: QFlareBot 自带的 sid（查身份）与 t2i（HTML 转图片）两个插件的命令和用法。
---

# 内置插件

仓库自带两个插件，写在 `apps/seed/qqbot.manifest.json` 里，部署后默认开启：`sid` 查身份，`t2i` 给别的插件提供 HTML 转图片服务。更多插件去[插件市场](./market.md)装。

不想要哪个，在面板「插件」页把它关掉就行，即时生效、不触发构建。面板上卸载不了内置插件；要从部署里彻底拿掉，改 `qqbot.manifest.json` 并提交。

下面的命令都以默认前缀 `/` 为例。群里 @机器人 或单聊时可以不带前缀。

## sid：查身份

`/sid`（别名 `/id`）回复你在这个机器人下的 openid、当前会话 id 与场景、你在群里的角色，以及机器人的名字和 AppID。群聊和单聊里用 markdown 回复，openid 和会话 id 各放一个代码块，点复制按钮就能拿到；频道没开放 markdown，仍回纯文本。

部署完用它检查机器人能不能收发消息。面板「设置 → 权限」里配 Bot 管理员名单要填 openid，也先用它查。openid 按机器人隔离，从别处复制来的无效。

## t2i：HTML 转图片服务

没有命令。它给别的插件提供一个 `t2i` 服务：把 HTML 渲染成图片，适合做海报、排行榜这类图文消息。用法是在插件里声明 `depends: { t2i: '*' }`，再 `ctx.service('t2i')` 取出来调用（见[插件开发指南 · 要读别的插件的数据](./plugin-guide.md#要读别的插件的数据)）。

发图用 `renderUrl(html)`：图存在渲染服务上，只回一个地址，放进 `{ image: { url } }` 让 QQ 自己去拉，图片不经过 Worker。`renderBase64(html)` 要在 Worker 里把整张图编码一遍，吃的是全机器人共享的 CPU，只在拿不到地址时用。

渲染不在 Worker 里做（CPU 不够），而是调用外部的 [AstrBot T2I](https://github.com/AstrBotDevs/AstrBot) 渲染服务：

| 配置 | 说明 |
| --- | --- |
| `t2i_url` | 渲染服务地址，要支持 `POST /text2img/generate`。默认是作者部署在 Hugging Face 上的公共实例，不保证可用，量大的话自己部署一个 |
| `t2i_timeout` | 渲染超时（毫秒，5000–30000，默认 25000）。上限是 30 秒，因为一次事件的全部处理只有 30 秒，再长也会被平台掐断；以前存过更大的值照旧生效，下次在面板保存时要改到 30000 以内 |

面板侧栏「插件页面 → T2I 渲染服务」可以测试连通性、试渲染一段 HTML。

## 以前的演示插件

早期版本还预装了 `echo`、`multi-reply`、`image`、`keyboard` 四个演示插件，现在已经去掉。升级后它们会在下次构建时从 Worker 上消失；`keyboard` 存过的按键点击记录会出现在面板「存储」页的「孤儿数据」里，可以在那里清掉。写插件要参考按键用法，看[插件模板](https://github.com/QFlareBot/QFlareBot/blob/main/templates/plugin/src/index.ts)。
