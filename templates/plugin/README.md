# qqbot-plugin-example

运行在 Cloudflare Workers 上的 QQ 机器人插件模板。复制本目录、改掉包名即可开始开发。

## 开发

```bash
npm install
```

- `src/index.ts`：插件入口，必须默认导出 `definePlugin(...)`。示例包含一个命令 `/hello`、一个正则 `ping`、一个 `qq.group.robot_added` 事件，以及面板据以渲染配置表单的 `configSchema`。
- `name` 建议与 npm 包名（去 scope）一致，只能用小写字母、数字、`-`、`_`。
- 插件不 import 运行时，所有能力（配置、KV、D1、日志、OpenAPI）都从处理器参数的 `ctx` 上取。
- 只能 import `@qqbot/sdk` 与普通 npm 包；`cloudflare:workers` 等 Workers 内建模块可以用，构建时会保留为外部依赖。

## 测试

```bash
npm test          # vitest
npm run typecheck # tsc --noEmit
```

`@qqbot/sdk/testing` 提供 `runCommand`、`createMockSession`、`createMockContext` 等工具，不需要运行时就能直接驱动处理器并断言回复，见 `src/index.test.ts`。

## 构建

```bash
npm run build     # 等价于 qqbot-plugin build
```

产物在 `dist/`：

- `dist/plugin.js`：单文件 ESM，已把 `@qqbot/sdk` 与所有依赖打进去，只保留 `cloudflare:*` 为外部 import；
- `dist/plugin.js.map`：source map；
- `dist/manifest.json`：从插件定义抽出的纯数据清单（名称、版本、命令、事件、配置 Schema 等），版本取自 `package.json`。

只想校验定义而不打包时运行 `npx qqbot-plugin validate`。

## 发布

1. 在仓库 Settings → Secrets 中添加 `NPM_TOKEN`（npm 的 Automation token）。
2. 首次运行 `npm install` 生成并提交 `package-lock.json`（CI 使用 `npm ci`）。
3. 修改 `package.json` 的 `version`，打同名 tag 并推送：

   ```bash
   npm version 0.1.1
   git push --follow-tags
   ```

`.github/workflows/release.yml` 会在 `v*` tag 推送时校验 tag 与 `version` 一致、构建、测试、`npm publish --access public`，并把 `dist/plugin.js`、`dist/manifest.json` 附到 GitHub Release。

## 安装到机器人

在框架管理面板里输入 `npm:<包名>@<版本>`（如 `npm:qqbot-plugin-example@0.1.0`），面板会从 npm 拉取该版本的 `dist/plugin.js` 与 `dist/manifest.json`，展示清单中声明的权限与配置项后完成安装。因此发布时请保证 `files` 包含 `dist`，且不要手工修改产物。
