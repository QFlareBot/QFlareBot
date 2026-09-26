# 升级与运维

部署好之后会用到的事：升级框架、看构建为什么失败、出问题时止损、换密钥，以及不用了怎么删干净。

## 升级框架：同步上游

升级就是把你的 Fork 同步到上游：

1. 打开你 Fork 的仓库首页，文件列表上方会显示「This branch is N commits behind」。
2. 点 **Sync fork**，再点 **Update branch**。

同步产生的提交推到 main 上，Workers Builds 会自动构建并部署，几分钟后生效。同步拿到的是上游 main 的最新代码，可能比最新发布的版本还新；每个版本改了什么见 [Releases](https://github.com/QFlareBot/QFlareBot/releases)，当前跑的版本显示在面板概览页的「运行时」里。

要知道的几点：

- **面板里装的插件都还在。** 构建机每次都从你机器人的 D1 读已装插件清单，和仓库里的内置插件合并后一起构建。插件钉在各自的提交上，不会跟着升级；它们会用新版框架重新编译，契约只增不改，插件不需要重新打包。
- **数据库表结构自己升级。** 运行时用到时自动建表、补字段，不用重跑引导工作流。
- **只改了文档的更新不会触发构建。** `docs/`、`templates/`、`.github/`、`scripts/`、`design-system/`、`*.md`、`LICENSE` 在构建的排除路径里。
- **同步触发的构建不在面板的「构建记录」里**，面板只记它自己触发的构建。这次构建的进度和日志到 Cloudflare 后台看，见下一节。

### 同步时有冲突

你自己在 Fork 里改过的文件，上游也改了同一处时，Sync fork 会提示冲突。常见的是：

- `apps/seed/wrangler.jsonc`：为 Durable Object 插件补过 `migrations`，或者改过 Worker 名；
- `apps/seed/qqbot.manifest.json`：去掉过内置插件。

这时**别点「Discard N commits」**，那会把你的改动丢掉，比如补过的 migrations 没了，下一次构建就会失败。点 **Open pull request**，在 GitHub 上解决冲突后合并；或者在本地合并：

```bash
git remote add upstream https://github.com/QFlareBot/QFlareBot   # 只需一次
git fetch upstream
git merge upstream/main    # 解决冲突后提交
git push
```

### 升级后确认

打开面板，概览页能看到机器人状态、最近事件照常刷新，就说明新版本在跑。在群里发一条 `/echo 你好` 更直接。

## 构建失败了

装插件、更新插件、同步上游都会触发构建。**只要有一个插件构建失败，整次构建就不部署**，线上保持上一次成功的版本，机器人不会因此停摆。

- **面板「插件」页**：「构建记录」列出面板触发的每次构建和状态，可以一键重新构建；「未上线的改动」列出没能上线的安装 / 升级 / 卸载和每个插件的失败原因。从没装上的可以直接卸载，升级失败的可以改回线上那一版。
- **完整日志**：面板里还看不到完整构建日志。到 Cloudflare 后台进入你的 Worker（默认叫 `qqbot`），在构建历史里点开那次构建。

失败的条目会一直留在清单里，之后的每次构建都会带上它、每次都失败，所以要处理掉：卸载、改回旧版，或者等插件作者修好后再更新。

## 出问题时止损

**安全模式**：面板「设置 → 运行时 → 安全模式」。打开后所有插件都不再处理消息和定时任务（按键回调仍会自动回应，客户端不会一直转圈），面板照常可用。它不触发构建，一分钟内全部生效。某个插件把机器人搞坏了、又不确定是哪个时先开它，再在「插件」页逐个关掉排查。

**回滚**，从轻到重：

- **单个插件**：「未上线的改动」里改回线上那一版，或在插件列表里关掉它。
- **整个 Worker**：Cloudflare 后台 Worker 的部署历史里把流量切回之前的版本。这是临时手段：下一次构建还会按 D1 清单和仓库的最新代码重新部署。
- **框架本身**：升级后出问题，在 Fork 上 `git revert` 同步进来的提交并推送，会按回退后的代码重新构建。

## 换密钥

**面板登录密钥 `ADMIN_TOKEN`**：在 Cloudflare 后台 Worker 的 **Settings → Variables and Secrets** 里改，或者本地 `wrangler secret put ADMIN_TOKEN`。改完之后所有已登录的面板会话、插件页面的令牌立即失效，用新密钥重新登录即可。重跑 Bootstrap 工作流也会用你这次填的值覆盖它。

**QQ 机器人的 AppSecret**：在 QQ 开放平台重置之后，旧的就不能用了，回面板「设置」重新填入保存。

**构建令牌 `BUILD_TOKEN`**：构建机拉插件清单用的，Worker 和构建环境各存一份（构建环境里叫 `MANIFEST_TOKEN`），两边要一起改，只改一边构建会 401。一般没必要换，步骤见 [apps/seed/README.md](https://github.com/QFlareBot/QFlareBot/blob/main/apps/seed/README.md#自部署worker-触发-workers-builds)。

## 免费版额度

整个机器人（框架加所有插件）共用一份 Workers 免费额度。个人用、几个群的量一般够用，要留意的是：

- **Worker 请求每天 10 万次**（UTC 0 点，即北京时间早上 8 点重置）。每条推给机器人的消息算一次，框架的定时任务每分钟一次、一天先占 1,440 次。群里开了「获取群内全部消息」之后，每条群消息都算，活跃群会涨得很快。
- **KV 每天只能写 1,000 次**。每条消息都写 KV 的插件（签到、积分）几个群就能把它打满，之后当天的写入都会失败。
- **每次处理只有 10 ms CPU**。插件做了重活（大图处理、大 JSON）会偶发报错，表现是机器人时有时无地不回。

真到量了就升级 Workers 付费版。每项数字和写插件时的注意事项见[插件开发指南 · 平台限额](./plugin-guide.md#_9-平台限额-免费版的硬预算)。

## 安全

- **装的插件就是可信代码**：插件和框架跑在同一个 Worker 里，没有沙箱，`permissions` 只是告知。装之前看一眼仓库，插件目录也不做安全审核。
- **有条件的话，机器人单开一个 Cloudflare 账号**，和你别的站点、数据隔开。注意回调用的域名也得托管在这个账号下。
- `ADMIN_TOKEN` 用足够长的随机字符串，别和别的密码共用。

## 彻底删除

引导时没改过名字的话，资源都叫 `qqbot`：

1. Cloudflare 后台 Worker `qqbot` 的 **Settings → Domains & Routes** 里删掉自定义域名，再删除 Worker。
2. 删掉 KV 命名空间 `qqbot`、D1 数据库 `qqbot`、R2 桶 `qqbot-artifacts`（没激活 R2 的没有这个桶）。
3. Cloudflare **My Profile → API Tokens** 里删掉引导时创建的 token。
4. QQ 开放平台删掉机器人，或者清空回调地址。
5. 最后删掉 GitHub 上的 Fork。
