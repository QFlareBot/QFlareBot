# qflarebot-plugin-example

[QFlareBot](https://github.com/QFlareBot/QFlareBot) 的插件模板。复制本目录、改掉包名即可开始开发。

完整说明都在文档站，这里只列最常用的：

- [插件开发指南](https://qflarebot.github.io/plugin-guide)：事件、回复、配置、存储、定时任务、自带 Web 页面、平台限额
- [发布插件](https://qflarebot.github.io/publish)：登记到插件目录，出现在插件市场

## 开始

SDK 与构建工具不发 npm，从 QFlareBot 源码构建。把 QFlareBot 克隆到插件仓库旁边（`devDependencies` 里是 `file:../QFlareBot/packages/*`）：

```bash
git clone https://github.com/QFlareBot/QFlareBot
(cd QFlareBot && pnpm install --filter '@qqbot/plugin-cli...' && pnpm --filter '@qqbot/plugin-cli...' build)
cd qflarebot-plugin-hello    # 与 QFlareBot 同级
npm install
```

然后：

1. 改 `package.json` 的 `name`：仓库名 = 包名 = `qflarebot-plugin-<name>`（或 `@scope/qflarebot-plugin-<name>`）。
2. 改 `src/index.ts` 里 `definePlugin({ name })` 为去掉前缀的短名 `<name>`，只能用小写字母、数字、`-`、`_`。
3. 把 `LICENSE` 的署名和 `package.json` 的 `license` 换成你自己的。模板是 MIT，你的插件用什么协议都行。

## 命令

```bash
npm test          # vitest，@qqbot/sdk/testing 不需要运行时就能驱动处理器
npm run typecheck # tsc --noEmit
npm run build     # 生成 dist/plugin.js 与 dist/manifest.json
npm run sync      # 构建并把 dist/manifest.json 复制到仓库根目录
```

根目录的 `manifest.json` 是**声明清单**：机器人安装前读它展示权限、检查撞名和依赖，构建时再与源码抽出的清单比对，不一致就失败。改了插件定义就跑 `npm run sync`，和代码一起提交。CI（`.github/workflows/ci.yml`）会检查它有没有过期。

用了第三方包的话，写进 `dependencies` 并**提交 lockfile**，没有 lockfile 构建会失败。

## 装到机器人

推到公开的 GitHub 仓库，在机器人面板「插件 → 安装插件」里粘贴仓库链接。面板会自动取默认分支的最新提交，预检后安装并触发构建。只支持公开仓库。
