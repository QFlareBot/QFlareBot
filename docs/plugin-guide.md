# 插件开发指南

目标：只看这一篇，就能写出一个能用的插件。API 细节以 `@qqbot/sdk` 的类型注释为准；平台能力对照见 `capabilities.md`。跑在免费版部署上时，第 9 节的平台限额是硬约束，动笔前先扫一眼。

## 1. 最小可用插件

```ts
// src/index.ts
import { definePlugin } from '@qqbot/sdk'

interface Config {
  greeting: string
}

export default definePlugin<Config>({
  // 包名 qqbot-plugin-hello 去掉前缀的短名；构建时校验与 package.json 一致
  name: 'hello',
  displayName: '问好',
  description: '最小示例：命令 + 配置 + KV',
  permissions: ['kv'], // 仅供安装前展示，运行时不强制

  // 面板据此渲染配置表单并在保存时校验
  configSchema: {
    type: 'object',
    properties: { greeting: { type: 'string', title: '问候语', default: '你好' } },
    required: ['greeting'],
  },
  defaultConfig: { greeting: '你好' },

  commands: {
    // 返回值就是回复；ctx.config 是面板里保存的配置
    hello: ({ ctx, argText }) => `${ctx.config.greeting}，${argText || '朋友'}`,

    // 生成器连发多条（同一条消息的被动回复默认最多 5 条）
    async *count() {
      for (let i = 1; i <= 3; i++) yield `${i}`
    },

    // 运行时数据用 ctx.kv（自动加插件前缀，别的插件看不到）
    async remember({ session, ctx, argText }) {
      await ctx.kv.put(`note:${session.userId}`, argText)
      return '记住了'
    },
    async mynote({ session, ctx }) {
      return (await ctx.kv.get(`note:${session.userId}`)) ?? '没有记录'
    },
  },

  // 正则以模式为键，/…/i 形式带 flags
  regex: { '/^ping$/i': () => 'pong' },

  // 事件：入群欢迎（走 event_id 被动回复，不消耗主动消息额度）
  events: { 'qq.group.robot_added': ({ ctx }) => `${ctx.config.greeting}，我是机器人，发送 /hello 试试` },
})
```

配套文件与命令（详见模板 `templates/plugin`）。SDK 与 `qqbot-plugin` 不发 npm，从 QFlareBot 源码构建，和插件仓库并排放——模板的 `devDependencies` 指向 `file:../QFlareBot/packages/*`：

```bash
git clone https://github.com/qflarebot/QFlareBot
(cd QFlareBot && pnpm install --filter '@qqbot/plugin-cli...' && pnpm --filter '@qqbot/plugin-cli...' build)
cd qqbot-plugin-hello    # 与 QFlareBot 同级
npm install

npm run build            # 生成 dist/plugin.js + dist/manifest.json
npm run sync             # 把 dist/manifest.json 复制到仓库根目录（声明清单，随代码提交）
npm test                 # @qqbot/sdk/testing 提供 runCommand / createMockSession / createMockContext
```

装到机器人：面板 → 插件 → 安装插件，粘贴仓库链接，先预检（权限、命令重名、要补的 DO migrations 一次列出来），确认后安装并就地触发构建——等价于 `POST /admin/manifest/plugins` 提交 `{"source": "git:<owner>/<repo>@<完整commit>"}`（加 `"dryRun": true` 只预检不写）。构建机拉源码编译，声明清单与源码不一致会直接失败。**只支持公开的 GitHub 仓库**：安装时匿名读仓库里的 `manifest.json`，构建机也是匿名下载源码，私有仓库两步都会 404。

安装记录钉在具体 commit 上——推了新代码不会自动生效。更新就是换到上游默认分支的最新提交：面板「已装插件」里点「检查全部更新」，勾选要更新的，点「更新选中」——逐个写进清单、**只触发一次构建**（API 上是每个 `POST /admin/manifest/plugins` 带 `"build": false`，最后 `POST /admin/builds`）。单个插件的 `check-update` / `update` 端点照旧可用。

构建失败时线上保持上一次成功的版本，失败原因回报到面板：插件页「未上线的改动」列出所有写进了清单、却还没在线上生效的安装 / 升级 / 卸载，从没装上的可以直接卸载，升级失败的可以改回线上那一版。

## 2. 规则

- **零运行时 import**：插件不 import 运行时，所有能力从处理器入参的 `ctx` / `session` 上取。`cloudflare:workers` 需在处理器内部 `import()`。
- **不发 npm 包**：插件以源码仓库分发，构建机编译部署，全程不向 npm 发布任何东西。
- **第三方依赖可以用，但要满足三条**：
  1. 写进插件自己 `package.json` 的 `dependencies`，并**提交 lockfile**（`package-lock.json` 或 `pnpm-lock.yaml`）。构建机按 lockfile 装（只装 `dependencies`，不跑安装脚本），有依赖没 lockfile 直接构建失败——否则同一个 commit 不同时间会装出不同的代码。
  2. `@qqbot/sdk` 放 `devDependencies`：构建时一律用机器人仓库那一份。其他 `@qqbot/*` 不许 import，能力都从 `ctx` / `session` 上取。
  3. 能在 Workers 里运行：不依赖 Node 内置模块（`fs`、`net`、`child_process`……，构建时就会报找不到）、不用 `eval` / `new Function`（运行到那一行才报错）。另外依赖的体积和初始化耗时算在全机器人共享的 CPU 里（见第 9 节），别拿大库做小事；只在浏览器里能加载的包（顶层就碰 `window` 之类）要在处理器里按需 `import()`，因为构建机是在 Node 里执行入口抽清单的。

  构建机只装插件自己声明的依赖，而且在机器人仓库外面构建：以前「先在机器人仓库 `pnpm add` 再重建」的做法不再有效。没有第三方依赖的插件不走安装，与以前一样。
- **命名**：包名 = `qqbot-plugin-<name>`（或 `@scope/qqbot-plugin-<name>`），`name` 用小写字母/数字/`-`/`_`——它同时是 KV 前缀、D1 表前缀、路由 `/p/<name>/` 前缀与撞名检测键。
- **版本**：取自 `package.json` 的 `version`。
- **permissions 只是告知**：插件与核心同 isolate、无沙箱，声明的权限运行时不强制。

## 3. 接收事件

运行时把 QQ 推送标准化为 `Session` 后分发。所有处理器入参都是**单对象**，加字段向前兼容：

| 匹配器 | 入参（除 session/ctx 外） | 默认 |
| --- | --- | --- |
| `commands` | `command`（命中的命令名或别名，子命令是完整的几个词）、`args: string[]`、`argText`（命令后的原文） | `block: true` |
| `regex` | `match: RegExpMatchArray` | `block: false` |
| `events` | — | `block: false` |
| `buttons` | `interaction`、`buttonId`、`buttonData` | `block: true` |
| `cron` | `job`、`scheduledAt`（**没有 session**） | — |
| `routes` | `request`、`params`、`authenticated` | public |
| `middleware` | `next()`，不调即拦截 | 按 priority 排序 |

`block` / `priority`（大者先执行）/ `scenes`（限定 `group | c2c | guild | guild_dm`）写在匹配器对象形式里。命令前缀默认 `/`，面板可改；命令名大小写不敏感。

**@ 机器人或单聊时命令可以不带前缀**（规则同 AstrBot）："@机器人 签到"等同于"/签到"。群里没开"接收全部消息"的机器人收到的都是 @ 消息，所以群聊和单聊基本都不用打前缀；判断依据见下文 `session.atMe`。

**命令名带空格就是子命令**，每条都是普通命令，`permission`、`scenes`、`usage` 照常各写各的：

```ts
commands: {
  pixiv: () => HELP,                              // 单独 /pixiv，或后面跟了不认识的词
  'pixiv random': ({ args }) => …,                // args 从 random 后面开始
  'pixiv illust': { usage: '/pixiv illust <id>', handler: ({ args }) => … },
},
```

名字越长越优先（跨插件也一样），所以 `/pixiv random 大图` 只会进 `'pixiv random'`；对不上的落回 `pixiv`，`args` 照常给，和不写子命令时一样。子命令权限不够时不会退回父命令。别名不会自动组合：`pixiv` 有别名 `p站`，要 `/p站 random` 也能用，得在子命令的 `aliases` 里写 `'p站 random'`。

正则只用来「判断命中 + 取捕获组」，所以运行时编译前会**剥掉 `g` 和 `y`**：带 `g` 时 `String.match` 只返回整段匹配、`match[1]` 会是 `undefined`；`y` 和 `g` 还会把 `lastIndex` 留在正则实例上，让重复匹配的结果漂移。写 `/^echo (.+)$/` 就够了，不用加这两个标志。

命令加 `bare: true` 后，**没 @ 机器人**的消息也按**首词**匹配它（带前缀调用同样命中）。只有群开了"接收全部消息"、或频道私域收全量消息时才用得上：

```ts
commands: {
  sign: { bare: true, handler: () => '已签到' },
},
```

裸命令只应在确实需要时用——群聊首词极易撞上正常聊天。

### 权限

命令与正则可声明 `permission`（不声明即 `member`，人人可用），运行时在匹配阶段拦截，不达标连 handler 都不会执行：

| 值 | 谁能通过 |
| --- | --- |
| `member` | 所有人（默认） |
| `group_admin` | Bot 管理员、群主、群管理员（群角色来自入站消息） |
| `bot_admin` | Bot 管理员（面板"设置 → 权限"里维护的 openid 名单） |

**达标制**：上层自动通过下层门槛。单聊没有群角色，层级塌缩成"Bot 管理员 / 普通成员"两档——`group_admin` 命令在单聊只有 Bot 管理员能用。按钮回调**暂不鉴权**（回调事件不带群角色）。

权限不足默认**静默跳过**（当作没匹配到，不遮蔽其他插件）；面板可设置统一回复文案，仅在没有任何插件命中时回复。需要更细的判断时在 handler 里读 `session.memberRole`（群聊时为 `'owner' | 'admin' | 'member'`，单聊/频道为 undefined）。

配置 Bot 管理员名单前，先在会话里发内置插件的 `/sid` 查询自己的 openid——openid 按机器人隔离，别处复制来的无效。

常用事件名（完整映射见 `docs/capabilities.md`）：

| 事件名 | 含义 |
| --- | --- |
| `qq.group.at_message` / `qq.group.message` | 群里 @机器人 / 群消息 |
| `qq.c2c.message` | 单聊消息 |
| `qq.guild.at_message` / `qq.guild.message` / `qq.guild.direct_message` | 频道消息 |
| `qq.group.robot_added` / `robot_removed` | 机器人群里被添加 / 移出（可用 event_id 被动回复） |
| `qq.group.member_added` / `member_removed` / `join_request` | 群成员变动 / 入群申请 |
| `qq.c2c.friend_added` / `friend_removed` | 加 / 删好友 |
| `qq.interaction` | 按键/菜单回调（一般用 `buttons` 匹配器，不用直接监听） |

平台新事件自动落到 `qq.raw.<t 小写>`（如 `qq.raw.group_msg_reject`），不必等框架发版。

`session` 只读字段（完整类型见 `@qqbot/sdk`）：

- **消息**：`content`（去 @ 后正文）、`mentions`（@ 的对象列表 `{ id, username, bot }`）、`atMe`（是否在呼叫本机器人：单聊/频道私信恒为 true，@ 消息由事件类型判定，群全量消息看平台在 mentions 上标的 `is_you`，频道全量消息按 mentions 里的 bot 标记尽力推断）、`attachments`、`messageId`、`refIndex`
- **身份**：`userId`、`userName`、`memberRole`（群聊时的 owner/admin/member）、`avatarUrl`（用户头像 CDN 直链，640 规格，纯拼接不发请求；其他尺寸用 `qqAvatar(botId, openid, 140)`，@ 人用 `qqAt(openid)`）、`botName` / `botAvatar`（机器人自己的资料）
- **事件与会话**：`event`、`scene`、`targetId`、`canReply`、`interaction`、`raw`（QQ 原始 `d`，标准化不够用时直接读它）

## 4. 回复消息

- 处理器**返回值就是回复**：字符串、消息对象、或（异步）可迭代对象逐条发。返回 `undefined` 表示自己处理完，不回复。
- `session.reply(msg)`：被动回复本次事件（`msg_seq` 自动编号，默认上限 5 条）。
- `session.send(msg, target?)`：主动发送；不传 target 发往当前会话。返回 `SendResult`（`ok` / `status` / `messageId` / `error`），**记得检查 `ok`**。
- `session.canReply`：当前事件能否被动回复；返回值投递会自动退化成主动发送。

消息对象（字符串即纯文本）：

```ts
{
  text: '文字',
  image: { url: 'https://…' },                  // 或 base64
  media: { type: 'video', url: 'https://…' },   // video | voice | file；图 png/jpg、视频 mp4、语音 silk
  markdown: { content: '# md' },
  keyboard: keyboard([[button.callback('确认', 'data', { id: 'confirm' }), button.link('文档', 'https://…')]]),
  quote: true,                                  // 引用当前消息；传 refIndex 字符串引用指定消息
}
```

`keyboard` 会自动把消息升级为 markdown（平台要求）。按键的 `id` 对应 `buttons` 匹配器的键；按键处理器返回数字即回应平台（0 成功 · 4 无权限 …），返回消息则回复并自动 ack——客户端永远不会转圈。

辅助：`session.typing(seconds)`（仅单聊，≤60s）、`session.stream()`（仅单聊流式，群聊退化为 end 时一次性回复）、`session.recall(id?)`（不传撤回自己最后一条，平台限 2 分钟内）。

## 5. 配置

- **声明**：`defaultConfig` 出厂默认 + `configSchema`（JSON Schema）。面板按 schema 渲染表单，保存时校验（覆盖 string / number / boolean / 枚举 / 字符串数组与 `required`；复杂对象退化为 JSON 文本框）。
- **存放**：面板保存写 KV 快照，与部署解耦——改配置不触发构建，即时生效（其他节点最长约 1 分钟）。
- **读取**：处理器里 `ctx.config`，类型由 `definePlugin<Config>` 串联。按顶层字段合并：保存过的配置盖在 `defaultConfig` 上，快照里没有的字段回落默认值——所以升级后新增的配置项，保存过配置的用户也拿得到默认值。

配置放"人工可改的设置"；插件的运行数据用下面的存储。

**不用自己做群白名单/黑名单**：面板的插件详情页有「生效的群」（所有群 / 只在这些群 / 除了这些群），框架在分发时就把不生效的群挡掉，插件在那个群里连中间件都不会跑。它只管群，单聊、频道、定时任务与 HTTP 路由不受影响。

## 6. 存储状态

三个按插件名自动隔离的存储，互相不可见：

| 存储 | 隔离方式 | 要点 |
| --- | --- | --- |
| `ctx.kv` | 键前缀 `p:<名>:` | `get / getJSON<T> / put(key, value, { ttl? }) / delete / list(prefix?)`；ttl 最小 60 秒 |
| `ctx.db` | 表名前缀 `p_<名>_` | SQL 里写 `{表名}` 占位，运行时展开；`run(sql, ...params)` / `all<T>` / `first<T>` 支持参数绑定；`exec` 跑建表语句 |
| `ctx.r2` | 键前缀 `p/<名>/` | 大文件：`put(key, value, { contentType? }) / get / getText / getJSON / getStream / delete / head / list` |
| `ctx.durable` | 命名空间 `P_<名>_<类名>` | 强一致单点，见下；`get(类名, 实例名)` / `namespace(类名)` |

未绑定 D1 / R2 时调用会抛可读错误（绑定见 seed 的 `wrangler.jsonc`）。建表放 `hooks.onInstall`：

```ts
hooks: {
  // 钩子的参数就是 ctx 本身，不是 { ctx }
  async onInstall(ctx) {
    await ctx.db.exec(`
      CREATE TABLE IF NOT EXISTS {notes} (user_id TEXT PRIMARY KEY, note TEXT, ts INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS {notes_ts} ON {notes}(ts);
    `)
  },
  async onBoot(ctx) { /* 每个 isolate 一次的轻量初始化 */ },
},
```

`exec` 可以一次写多条语句、随意换行和写 `--` 注释：D1 的 `exec` 本身按行拆语句，跨行的 `CREATE TABLE` 会从第一行断掉，框架交给 D1 之前会先压成一行。唯一的限制是**引号里不能换行**（压行会改掉值，框架会直接报错），带换行的数据用 `run()` 绑定参数写入。

D1 的 `{表名}` 不是语法糖，是硬规则：SQL 里出现不带本插件前缀的表名会**直接抛错**，`sqlite_master`、加引号、加库名限定都拦，`ATTACH` / `PRAGMA` 整条拒绝。字符串字面量和注释里的内容不受影响，往库里塞 JSON 不会被误伤。

这么做有两个原因，第二个才是重点：一是插件之间不会撞表或误删；二是**框架凭前缀才知道你建过哪些表，卸载时才清得掉你的数据**。表名一旦逃出命名空间，那部分数据就永远变成没人管的孤儿。

```ts
await ctx.db.run('INSERT INTO {notes} (user_id, note, ts) VALUES (?, ?, ?)', id, note, Date.now())
const rows = await ctx.db.all<Note>('SELECT * FROM {notes} WHERE user_id = ? ORDER BY ts DESC', id)
```

注意：**没有 onUpgrade 钩子**——升级版本不触发任何钩子，表结构/数据迁移请在 `onBoot` 里做惰性检查（`onInstall` 的 KV 标记保证它跨部署只跑一次）。`onEnable` / `onDisable` 已在契约中但运行时尚未接入；`onUninstall` 已接入，见下。

### 卸载时的数据

卸载会先调用你的 `hooks.onUninstall(ctx, { purgeData })`——趁插件代码还在这次部署里，给你一次收尾机会（前缀之外的东西、外部服务上的资源）。它抛错不会挡住后面的清理。

之后框架按前缀兜底：`purgeData` 为真时删光你的 KV 键、R2 对象和 D1 表。**默认是 false**，数据留着；面板的存储页会把它标成孤儿，可以随时单独清掉。无论清不清数据，`onInstall` 的"已装过"标记都会删掉，所以重装一定会重新建表。

重建完成之前（几分钟）插件代码还在线上跑：冷启动的实例读不到标记会重跑 `onInstall`，把表建回来、把标记写回去。所以框架在**新版本上线、插件确实不在部署里之后**再由定时任务收一次尾——再删一遍标记，选了清数据的再清一遍（连面板里保存的配置一起）。这期间又装回来的话，这次收尾会被取消。

### 要读别的插件的数据

不要直接查它的表——查不到（前缀拦着），而且就算能查也不该查：直连是隐形依赖，对方改表结构或被卸载，你会静默坏掉，框架也看不见这层关系。

正确做法是让数据的持有方导出 service：提供方声明 `services: { 名: (ctx) => 对象 }`，使用方声明 `depends: { 名: '*' }` 后 `ctx.service<类型>('名')`。这样依赖写在清单里，安装时会校验，面板上看得见。depends 未满足会在安装时被拒绝。

### Durable Object：装之前得先改机器人仓库

上面三个存储都是「最终一致、无协调」的。需要**强一致的单点**（同一个房间/同一场对局必须串行处理）、跨请求常驻的内存状态、WebSocket 长连接或 `alarm()` 自唤醒时，才轮到 Durable Object。绝大多数插件不需要——先确认 `ctx.kv` / `ctx.db` 真的解决不了，DO 带来的麻烦比它们多得多。

类必须继承 `PluginDurableObject`，再挂到 `durableObjects` 上：

```ts
import { definePlugin, PluginDurableObject } from '@qqbot/sdk'

export class Room extends PluginDurableObject {
  async join(userId: string) {
    await this.plugin.db.run('INSERT OR IGNORE INTO {members} (id) VALUES (?)', userId)
    const rows = await this.plugin.db.all<{ n: number }>('SELECT COUNT(*) AS n FROM {members}')
    return rows[0]?.n ?? 0
  }
}

export default definePlugin({
  name: 'game',
  durableObjects: { Room },
  commands: {
    join: async ({ ctx, session }) => {
      const room = ctx.durable.get<Room>('Room', session.groupId ?? 'dm')
      return `当前 ${await room.join(session.userId)} 人`   // RPC，直接拿返回值
    },
  },
})
```

三件事一起看：

- **`ctx.durable.get(类名, 实例名)`** 取实例，实例名走 `idFromName` —— 一个群 / 一个用户 / 一局游戏一个实例。类名不在自己 `durableObjects` 里会抛错，够不到别的插件的 DO。需要 `newUniqueId` / `idFromString` 时用 `ctx.durable.namespace(类名)`。
- **`this.plugin`** 是 DO 里的作用域上下文（`kv` / `db` / `r2` / `logger`），前缀与处理器里的 `ctx.kv` / `ctx.db` 完全一致 —— 所以 DO 里建的表卸载时也清得掉。没有 `api` 与 `config`：两者都要读快照，同步构造器等不了。`this.ctx` 仍然是平台的 `DurableObjectState`（`storage`、`blockConcurrencyWhile` 照用）。
- **继承是强制的，`qqbot-plugin build` 会拦。** 不继承的话平台把**未加前缀的裸 env** 直接塞给你，第 6 节那套「前缀即所有权」在 DO 里就失效了：建的表框架不认识，卸载时清不掉，永远是孤儿。这种「忘了就出事、出事还看不见」的约定不能只写在文档里，所以放在构建期挡住。

投影时框架把类以 **`P_<插件名>_<类名>`** 导出到 Worker 主模块（插件名里的非字母数字换成 `_`，所以是 `P_game_Room`），并在导出时挂上作用域工厂 —— `PluginDurableObject` 的构造器就是靠它把裸 env 换掉的。因此 DO 类只能经由投影入口导出，手工在 `wrangler.jsonc` 里导出会在构造时抛错。

**关键一步：安装会被拦下，要先往机器人仓库补一条 migrations。** 面板预检时会把要加的内容原样给出（直接调安装 API 则返回 409 `durable_objects_migration_required`，内容相同）：

```jsonc
// apps/seed/wrangler.jsonc 的 migrations 末尾追加（tag 不能与已有重复）
{ "tag": "p-game-room", "new_sqlite_classes": ["P_game_Room"] }
```

提交推送之后，回面板点「已加好 migrations，确认安装」即可（API 上是带 `acknowledgeDurableObjects: true` 重新安装）。只有**新增**的类才会被拦：以后升级时 DO 类没变就直接更新，新版本多了类才要再补一条。

为什么不能自动：`migrations` 是**只追加的历史**，平台记着「上次应用过的 tag」，下次部署拿它在列表里定位、只应用其后的新增项。构建机每次都是全新环境，没有这个状态，造不出正确的历史——所以投影对它只校验、不合成。而校验发生在构建阶段，不在安装这一步拦住的话，插件已经写进 D1 才炸，并且**此后每一次构建都会炸**（包括之后装别的插件），直到有人想起来把它卸载。

**两条安全阀在 DO 面前会失效**，这是选它之前要接受的代价：DO 类必须静态导出、随主模块求值，所以求值抛错会拖垮整个 Worker，而不是只影响自己（第 3 节「动态 import 隔离」的例外）；另外含 DO 的 Worker 没有版本预览 URL，部署时的 `/healthz` 健康检查会被跳过，坏版本不会在切流量前被拦下。

卸载同样要手动收尾：类从 bundle 里消失之后，`wrangler.jsonc` 的 `migrations` 里那条 `new_sqlite_classes` 还留着。走 Versions API 的正常部署不受影响，但一旦降级到 `wrangler deploy`，声明了却不存在的类可能被拒（需要补一条 `deleted_classes`）。**这条我没有实测过**，卸载 DO 插件之后留意一下构建日志。

## 7. 定时任务与主动推送

```ts
cron: {
  daily: {
    cron: '0 1 * * *', // 5 段，UTC！北京时间 9 点 = 1 点；支持 * a-b a,b 与 / 步进
    async handler({ ctx, job, scheduledAt }) {
      await ctx.api.sendMessage({ scene: 'group', id: '群openid' }, `日报：${job}@${new Date(scheduledAt).toISOString()}`)
    },
  },
},
```

`cron` 处理器**没有 session**（不是事件），主动推送用 `ctx.api.sendMessage`。群聊主动消息需要平台白名单。`ctx.api` 上还有 `raw(method, path, body)`（框架未封装的接口直接调，永远可用）与 `group.*`（群管理）。

## 8. HTTP 路由与插件页面

```ts
ui: { path: '/ui/', title: '我的页面' },   // 面板侧栏出现入口
routes: [
  // auth: 'admin' 接受面板会话或本插件的桥接令牌；默认 public（任何人可访问）
  { method: 'GET', path: '/ui/*', auth: 'admin', handler: () => new Response('<h1>…</h1>', { headers: { 'content-type': 'text/html' } }) },
  { method: 'GET', path: '/api/data', auth: 'admin', handler: async ({ ctx }) => Response.json(await ctx.kv.getJSON('data') ?? {}) },
],
```

`path` 支持 `:param` 与末尾 `/*` 通配（键为 `*`）。插件页面跑在面板的 sandbox iframe 里，用 `@qqbot/ui-bridge` 拿令牌、主题与 resize，见 `docs/ui.md` 与 `plugins/keyboard` 示例。

## 9. 平台限额：免费版的硬预算

整个机器人——运行时加所有插件——是**一个 Worker、一个 isolate**（第 2 节"同 isolate、无沙箱"），Cloudflare 的限额按调用分给全体共享：某个插件超限，趴下的是整台机器人。免费版（Workers Free）预算尤其紧，数字以官方 limits 页为准（2026-09 核对）。

**每次调用共享**（HTTP 请求与 cron 调度同一套）：

| 项 | 免费版 | 付费版 |
| --- | --- | --- |
| CPU 时间 | **10 ms** | 默认 30 s（可调至 5 min） |
| 内存 | 128 MB | 128 MB |
| 子请求（KV / D1 / R2 / fetch 全算） | **50** | 10,000 |
| 同时等响应头的连接 | 6 | 6 |
| 全局作用域启动 | 1 s | 1 s |

**按天 / 月计**（免费版，同样全框架共享）：

| 项 | 免费版额度 |
| --- | --- |
| Worker 请求 | 100,000 次/天（UTC 0 点重置；cron 每分钟调度一次，一天先扣 1,440） |
| KV | 读 100,000 次/天；写、删、列各 1,000 次/天；同一 key 写 1 次/秒；单值 25 MiB；总容量 1 GB |
| D1 | 读 500 万行/天；写 100,000 行/天；单库 500 MB；每账户 10 库共 5 GB；单条 SQL ≤100 KB、绑定 ≤100 个、单值 ≤2 MB |
| R2 | 存储 10 GB·月；Class A（写/列）1,000,000 次/月；Class B（读）10,000,000 次/月 |

Cron Triggers 免费版每账户只有 5 个——框架只注册一个每分钟触发器、再按插件的 cron 表达式内部分发，插件随便声明都不会撞这个限制，但**每次调度同样只有 10 ms CPU**。

据此有几条纪律：

- **CPU 是全家共用的 10 ms**。官方统计普通请求平均约 2.2 ms——验签、匹配、其他插件先分掉一波，留给你的是零头。CPU 或内存超限的表象都是整个 Worker 偶发 1102，砸的是所有人。别在 handler 里干重活：大 JSON 解析、长循环、密码学哈希、几 MB 媒体的 base64 编码。重活外移——t2i 把渲染扔给外部渲染服务就是这个模式，压缩、转码、OCR 同理；发媒体优先给 `image.url`，别在 Worker 里转 base64。
- **子请求 50 是硬顶**。一次消息处理里，每次 KV / D1 / R2 / fetch 都计 1。循环里逐条 `kv.put` 的写法 50 次就断：热路径（计数器、排行榜）用 D1 一条 SQL 顶 N 次 KV，批量写合并进 `exec` / batch。
- **日配额是全机器人共享的**，不是每插件一份。"每条消息都写库"的设计（签到、积分）会把 KV 每天 1,000 次写几天内打满，同一 key 还限 1 次/秒，并发就报错——加去重、攒批、内存缓存 + 定时落盘（落盘那次的 CPU 依然在 10 ms 里）。请求 100,000 次/天看着多：一条群消息就是一次 webhook，几个活跃群加 cron 底座就能摸到，真到量就升级付费版——CPU 30 s、子请求 10,000，上面大半焦虑直接消失。
- **内存 128 MB 同样共享**。大响应别整个读进内存，能流式就流式（`ctx.r2.getStream`）；大媒体先落 R2。`ctx.waitUntil` 的后台任务和本次请求共享 CPU / 内存预算，不是白给的。
- **cron 处理器按 10 ms 写**。每日汇总这类任务要么足够轻，要么只做"发起"，把重活交给外部服务异步完成。

## 10. ctx 速查

| 字段/方法 | 说明 |
| --- | --- |
| `ctx.config` | 面板保存的配置（缺的顶层字段回落 defaultConfig） |
| `ctx.kv` / `ctx.db` / `ctx.r2` | 隔离存储，见第 6 节 |
| `ctx.durable` | 自己声明的 Durable Object：`get(类名, 实例名)` / `namespace(类名)`，见第 6 节 |
| `ctx.api` | QQ OpenAPI：`me()`（机器人资料）/ `sendMessage` / `uploadMedia` / `typing` / `streamChunk` / `recallMessage` / `ackInteraction` / `group.*`（含群信息、禁言、审批、入群策略）/ `raw()`。非 2xx 统一抛带错误码说明的 `QQApiError`，结果型方法转为 `SendResult.error` |
| `ctx.logger` | `debug / info / warn / error`，结构化 JSON 行 |
| `ctx.service(name)` | 取其他插件提供的服务（需在 depends 声明） |
| `ctx.waitUntil(p)` | 后台任务在响应返回后继续执行 |
| `ctx.plugin` / `ctx.botId` | 自己的名字与版本 / 机器人 AppID |

有疑问先看三份代码：`templates/plugin/src/index.ts`（起步示例）、`plugins/keyboard`（按键 + 插件页面）、`@qqbot/sdk` 的类型注释（字段级真相）。
