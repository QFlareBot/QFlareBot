# qqbot-plugin-example

运行在 Cloudflare Workers 上的 QQ 机器人插件模板。复制本目录、改掉包名即可开始开发。

> 完整的插件开发指南（事件 / 回复 / 配置 / 存储 / 生命周期）见 QFlareBot 仓库的 [docs/plugin-guide.md](../../docs/plugin-guide.md)；本篇只讲模板自身的约定与发布流程。

## 开发

`@qqbot/sdk` 与 `@qqbot/plugin-cli` 不发 npm，从 QFlareBot 源码构建。把 QFlareBot 克隆到插件仓库旁边（`devDependencies` 里是 `file:../QFlareBot/packages/*`）：

```bash
git clone https://github.com/QFlareBot/QFlareBot
(cd QFlareBot && pnpm install --filter '@qqbot/plugin-cli...' && pnpm --filter '@qqbot/plugin-cli...' build)
cd qqbot-plugin-hello    # 与 QFlareBot 同级
npm install
```

CI 按同样的布局拉取并构建 QFlareBot。机器人的构建机不装 `devDependencies`，编译时一律用机器人仓库自己那一份 SDK。

- `src/index.ts`：插件入口，必须默认导出 `definePlugin(...)`。示例包含一个命令 `/hello`、一个正则 `ping`、一个 `qq.group.robot_added` 事件，以及面板据以渲染配置表单的 `configSchema`。
- 插件不 import 运行时，所有能力（配置、KV、D1、日志、OpenAPI）都从处理器参数的 `ctx` 上取。
- **可以用第三方包**：写进 `dependencies`、**提交 lockfile**（`package-lock.json` 或 `pnpm-lock.yaml`），机器人的构建机按 lockfile 安装、打进 `plugin.js`；有依赖没 lockfile 会构建失败。包必须能在 Workers 里跑（不依赖 Node 内置模块、不用 `eval`）。`@qqbot/sdk` 放 `devDependencies`，其他 `@qqbot/*` 不许 import；`cloudflare:workers` 等 Workers 内建模块可以用，构建时保留为外部依赖。
- 模板本身是 MIT，随便复制；复制后把 `LICENSE` 的署名和 `package.json` 的 `license` 换成你自己的（协议不限，不必跟框架一样用 GPL）。
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

## 构建与声明清单

```bash
npm run build     # 等价于 qqbot-plugin build
```

产物在 `dist/`：

- `dist/plugin.js`：单文件 ESM，已把 `@qqbot/sdk` 与第三方依赖打进去，只保留 `cloudflare:*` 为外部 import；
- `dist/plugin.js.map`：source map；
- `dist/manifest.json`：从插件定义抽出的纯数据清单（名称、版本、命令、事件、配置 Schema 等），版本取自 `package.json`。

仓库根目录的 `manifest.json` 是**声明清单**：机器人安装前读它展示权限、校验撞名/依赖，全程不执行你的代码。改了插件定义后运行 `npm run sync`（构建 + 把 dist/manifest.json 复制到根目录）并提交，CI 会校验两者一致，过期即失败。

只想校验定义而不打包时运行 `npx qqbot-plugin validate`。

## 发布（源码分发）

插件以**源码**分发，机器人侧在构建时按 commit 拉取源码、编译并校验声明清单。不需要发布 npm，也不需要构建制品：

1. 改 `package.json` 的 `version`；
2. `npm run sync` 同步声明清单，随代码一起提交；
3. 推 commit，把完整 commit SHA 记下来（安装时按 SHA 钉住，不要用分支名）。

CI（`.github/workflows/ci.yml`）在每次 push 时构建、校验声明清单一致性并跑测试；打 `v*` tag 时额外校验 tag 与 version 一致。旧制品模型（GitHub Release 附 `dist/`、`npm:` 安装）已废弃，机器人投影器虽兼容但不再使用。

## 安装到机器人

在机器人面板/管理 API 里安装，`source` 写法：

| 写法 | 说明 |
| --- | --- |
| `git:<owner>/<repo>@<完整commit>` | 推荐。构建时从该 commit 拉源码编译，声明清单同时用于安装前校验 |
| `git:<owner>/<repo>@<commit>#<子目录>` | 插件在 monorepo 子目录时用 |

```bash
curl -X POST https://<机器人域名>/admin/manifest/plugins \
  -H "Authorization: Bearer <管理密钥>" -H "content-type: application/json" \
  -d '{"source": "git:me/qqbot-plugin-example@a1b2c3d4e5f6"}'
```

只支持**公开的** GitHub 仓库：安装时匿名读仓库里的 `manifest.json`，构建机也是匿名下载源码。

安装端点写完清单会就地触发一次构建，上线后插件出现在面板里（见 seed README 的自部署设置）；一次装好几个时每个都带 `"build": false`，最后调一次 `POST /admin/builds`，只构建一次。构建时产物会记录 SRI 完整性；声明清单与源码不一致、依赖不满足、与已装插件冲突都会直接拒绝安装或构建失败，而不是静默部署。构建失败时线上保持上一次成功的版本，失败的插件会出现在面板插件页「未上线的改动」里，可以直接卸载。
