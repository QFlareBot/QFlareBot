# qqbot-plugin-example

运行在 Cloudflare Workers 上的 QQ 机器人插件模板。复制本目录、改掉包名即可开始开发。

## 开发

```bash
npm install
```

- `src/index.ts`：插件入口，必须默认导出 `definePlugin(...)`。示例包含一个命令 `/hello`、一个正则 `ping`、一个 `qq.group.robot_added` 事件，以及面板据以渲染配置表单的 `configSchema`。
- 插件不 import 运行时，所有能力（配置、KV、D1、日志、OpenAPI）都从处理器参数的 `ctx` 上取。
- 只能 import `@qqbot/sdk` 与普通 npm 包；`cloudflare:workers` 等 Workers 内建模块可以用，构建时会保留为外部依赖。
- 记得补一个 `LICENSE`，模板不替你选。

### 命名约定

仓库名 = 包名 = `qqbot-plugin-<name>`（或 `@scope/qqbot-plugin-<name>`），`definePlugin({ name })` 用**去掉前缀的短名**：

| package.json 的 `name` | `definePlugin({ name })` |
| --- | --- |
| `qqbot-plugin-hello` | `hello` |
| `@me/qqbot-plugin-hello` | `hello` |

`name` 只能用小写字母、数字、`-`、`_`，因为它同时是路由前缀 `/p/<name>/`、KV 前缀 `p:<name>:`、D1 表前缀 `p_<name>_`，也是安装时的撞名检测键。`qqbot-plugin build` 会校验这层关系，不一致直接报错。

不带 `qqbot-plugin-` 前缀也行，但那样包名必须与 `name` 完全相同。

### 关于 `permissions`

`permissions` **只用于安装前向用户展示**，运行时不做任何强制。插件与框架核心跑在同一个 isolate 里，无法沙箱——声明 `['kv']` 的插件照样拿得到 `ctx.db`。把它当作"告知"，不是"安全边界"。

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

插件以**预构建产物**分发——机器人部署时只拉 `plugin.js` 与 `manifest.json`，不会编译你的源码。所以每个版本都要跑一次构建并把产物发出去。

1. 首次运行 `npm install` 生成并提交 `package-lock.json`（CI 使用 `npm ci`）。
2. **在仓库 Settings → General 里开启 Immutable Releases**。开启后已发布 release 的资产与 tag 都会被锁死，tag 名即使删库重建也不能复用，并自动生成可校验的 attestation。不开也能用，但那样同一个 tag 的产物随时可被替换。
3. 修改 `package.json` 的 `version`，打同名 tag 并推送：

   ```bash
   npm version 0.1.1
   git push --follow-tags
   ```

`.github/workflows/release.yml` 会校验 tag 与 `version` 一致、构建、测试，然后**先建草稿 release 把产物附齐、再发布**——Immutable Releases 下已发布的 release 不能再传资产（HTTP 422），所以顺序不能颠倒。

不想用 npm 也完全没问题：机器人从 GitHub Release 拉产物，不经过 npm registry。

## 安装到机器人

在机器人的部署清单里加一条，`source` 三选一：

| 写法 | 拉取地址 | 说明 |
| --- | --- | --- |
| `github:<owner>/<repo>` | Release 资产 `v<版本>/plugin.js` | 配合上面的工作流，推荐 |
| `url:https://.../plugin.js` | 原样 | 把 `dist/` 提交进仓库，用 tag 或 commit 的 raw 链接，`git push` 即发布 |
| `npm:<包名>` | jsDelivr 的 `dist/plugin.js` | 需要发布到 npm |

版本固定写死，不支持 `^1.2.0` 这类范围——范围会让同一份清单在不同时间构建出不同代码。首次安装时会记录产物的 `integrity`（SRI 哈希），之后每次构建都重新校验，产物被换掉会**构建失败**而不是静默部署。

因此：发布后不要手工改动产物；要改就发新版本。
