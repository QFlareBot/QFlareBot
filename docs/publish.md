# 发布插件

插件写好了，在自己的机器人上也用顺了，就可以登记到插件目录，出现在[插件市场](./market.md)和每个机器人面板的「市场」页里，别人勾选就能装。

插件目录是 GitHub 仓库 [QFlareBot/plugins](https://github.com/QFlareBot/plugins)：每个插件一个条目文件，提 PR 登记，CI 自动检查，维护者合并后几分钟内上架。

## 登记前

- **仓库公开**：机器人安装时匿名读仓库，私有仓库装不上。
- **命名**：仓库名 = 包名 = `qflarebot-plugin-<name>`，`<name>` 是 `definePlugin({ name })` 里的短名。一个仓库放多个插件时仓库名不限，每个插件的包名照样要守这条。改名前的 `qqbot-plugin-<name>` 构建时还认，但登记不进目录。
- **声明清单**：插件目录下提交了 `npm run sync` 生成的 `manifest.json`，并且与源码一致。
- **依赖**：有第三方依赖的话提交了 lockfile（见[插件开发指南](./plugin-guide.md#_2-规则)）。
- **建议**：带上 LICENSE，给仓库加 topic `qflarebot-plugin`。

`name` 在目录里先登记的先得。比较时把 `-` 当成 `_`：`my-plugin` 和 `my_plugin` 的 D1 表前缀都是 `p_my_plugin_`，同一个机器人里装不到一起。下面这些名字保留，不能登记：

- 内置插件：`echo`、`multi-reply`、`image`、`keyboard`、`sid`、`t2i`
- 框架自己用的：`qqbot`、`qflarebot`、`core`、`admin`、`system`、`runtime`

## 提交

Fork [QFlareBot/plugins](https://github.com/QFlareBot/plugins)，在 `plugins/` 下新建 `<name>.json`：

```json
{
  "repo": "me/qflarebot-plugin-hello",
  "tags": ["娱乐"]
}
```

| 字段 | 说明 |
| --- | --- |
| `repo` | 必填，GitHub 仓库 `owner/repo` |
| `subdir` | 选填，插件在仓库子目录里时写相对路径，例如 `packages/hello` |
| `tags` | 选填，最多 5 个，每个不超过 12 个字 |

名称、版本、描述、权限、命令都不用写，从你仓库里的 `manifest.json` 读。改了插件，市场里的信息自然跟着变。

然后提 PR。CI 做三件事：

1. 检查条目：格式、撞名、保留名。
2. 读仓库默认分支的最新提交，核对：仓库公开、仓库名与包名符合约定、`manifest.json` 里的 `name` 与文件名一致。
3. 用机器人构建机同一套脚本把插件真构建一遍。声明清单与源码不一致、有依赖没 lockfile、用了 Node 内置模块，都会在这一步失败。

提 PR 之前可以在本地先跑一遍，需要一份装过依赖、构建过的 QFlareBot：

```bash
git clone https://github.com/QFlareBot/plugins && cd plugins
node scripts/check.mjs hello                      # 格式 + 联网核对
node scripts/check.mjs hello --build ../QFlareBot # 再加真构建
```

## 上架之后

- **发新版本不用再提 PR**：目录每 6 小时重读一遍所有插件的默认分支，市场里的版本、描述跟着变。
- **仓库改名**：GitHub 会重定向，目录照常工作，但请提 PR 把 `repo` 改成新地址。
- **不想再列出**：提 PR 删掉条目文件。
- **读不到的插件**（仓库删了、清单坏了）会在市场里标出来，不会马上删；长期修不好的，维护者会移除。

## 目录不是安全审核

插件与框架核心跑在同一个 isolate 里，没有沙箱，`permissions` 只是告知。目录只检查登记那一刻的代码能构建、名字不冲突；之后的每次更新都直接来自作者的默认分支，不经过目录。装插件前请自己看一眼仓库。

## 索引格式

目录的数据发布在 <https://qflarebot.github.io/plugins/index.json>，允许跨域读取，想做自己的插件列表可以直接用：

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-09-26T08:23:00.000Z",
  "plugins": [
    {
      "name": "jrys",
      "repo": "clown145/qflarebot-plugin-jrys",
      "installUrl": "https://github.com/clown145/qflarebot-plugin-jrys",
      "author": "clown145",
      "displayName": "今日运势",
      "description": "今日运势海报生成插件……",
      "version": "0.1.0",
      "tags": ["娱乐", "运势"],
      "permissions": ["net", "kv"],
      "commands": [{ "name": "jrys", "description": "抽取今日运势海报：/jrys 或直接发 运势" }],
      "depends": [],
      "services": [],
      "durableObjects": [],
      "hasUi": false,
      "license": "MIT",
      "stars": 3,
      "sha": "63e56c6…",
      "updatedAt": "2026-09-20T12:00:00Z",
      "status": "ok",
      "checkedAt": "2026-09-26T08:23:00.000Z"
    }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `installUrl` | 粘贴到面板「安装插件」的地址；子目录插件带上 `/tree/<默认分支>/<子目录>` |
| `depends` / `services` | 依赖与提供的服务名。面板批量安装时据此排顺序：提供服务的先写进清单 |
| `author` | 仓库 owner |
| `version` 等展示字段 | 来自最新提交的 `manifest.json`；`coreRange`、`subdir` 只在有的时候出现 |
| `sha` / `updatedAt` | 目录最后读到的提交与提交时间。面板安装时照常解析默认分支的最新提交，不用这个值 |
| `status` | `ok`，或 `error`：这次没读到，展示字段沿用上一次读到的，原因在 `error` |

`schemaVersion` 不变时只加字段、不删不改；读的一方遇到不认识的字段忽略即可。
