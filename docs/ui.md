# 管理面板与插件页面

## 面板（`@qqbot/ui`）

Vue 3 + Vite + Tailwind v4，hash 路由。构建产物由 `scripts/pack.mjs` 打成一张"路径 → 内容"表（`dist/ui.js`），作为普通模块进入 Worker bundle，由运行时在 `/` 下带 ETag 返回。不加载任何外部资源，字体用系统栈。

| 页面 | 作用 |
| --- | --- |
| 登录 | 用 `ADMIN_TOKEN` 换 7 天会话令牌（HMAC 签名、无状态），浏览器不再保存管理密钥 |
| 概览 | 机器人状态、插件数、24h 事件/错误、回调地址一键复制、最近事件表（每事件一行分发摘要）。事件摘要平时从 Workers Logs 读（约 15 秒延迟、不含正文，要构建 Token 带 Workers Observability 权限），D1 不为每个事件存一行；点「开始实时调试」才把新事件连同正文写进 D1，最多留 50 条，关掉页面或切到后台即停 |
| 插件 | 粘贴仓库链接安装（自动解析最新 commit，先预检：权限、第三方依赖、警告、要补的 DO migrations 一次列出，确认后再装）；「检查全部更新」后勾选批量更新，只构建一次；「未上线的改动」列出写进了清单、线上还没生效的安装 / 升级 / 卸载（构建失败的可以直接卸载或撤销）；有构建在跑时顶部提示并轮询，结束后自动刷新列表；构建记录、列表开关（即时生效）。详情页按 JSON Schema 渲染配置表单、优先级、生效的群（所有群 / 只在这些群 / 除了这些群，只管群消息与群事件）、触发器清单，以及**卸载**（可选连数据一起清，有插件依赖它时提示；仓库内置插件不显示按钮，改为提示改 `qqbot.manifest.json`；已卸载、等重建生效的显示「卸载待生效」） |
| 市场 | 在浏览器里读[插件目录](./market.md)的 `index.json`，搜索、按标签筛；勾选几个一起装：逐个解析最新 commit 并预检，按依赖顺序写进清单（`build: false`），最后只触发一次构建。文档站市场页的「安装」跳到这里（`/#/market?install=a,b`） |
| 存储 | 每个插件占用的 KV 键 / D1 表与行数 / R2 对象与字节数；卸载后留下的数据列为「孤儿」，可单独彻底删除 |
| 调试 | 事件模拟器：消息 / 按键点击 / 其他事件，显示会话解析、命中插件、出站消息、交互回应、流式分片、撤回。它是干跑：回复只记录不发给 QQ，没配机器人也能用；但插件里的存储读写与直接调 `ctx.api` 的请求是真的。同页的主动发消息会真的发出去 |
| 设置 | 凭证保存（先向 QQ 验证；也可扫码创建机器人，凭证由 Worker 解密后直接保存）；换 AppID 时旧机器人自动存进「已保存的机器人」，可一键切回或删除（AppSecret 只留在 Worker 的 KV，不回显）；运行时：安全模式、命令前缀；权限：Bot 管理员 openid 名单、权限不足时的回复文案；QQ 指令面板（可从已启用插件的命令一键生成）、分享链接、单聊自定义菜单；安全建议 |
| 插件页面 | 侧栏「插件页面」下按插件出现，见下节 |

设计 token 与规则见 `design-system/qflarebot/MASTER.md`；机器可读版本是 `@qqbot/ui-bridge/tokens.css`。

## 插件页面（解耦方案）

插件页面是**插件自己的路由返回的任意 HTML**，跑在 sandbox iframe 里，与面板框架无关。

```ts
export default definePlugin({
  name: 'foo',
  ui: { path: '/ui/', title: '我的页面' },          // 面板据此加菜单项
  routes: [
    { method: 'GET', path: '/ui/*', auth: 'admin', handler: async () => html(PAGE) },
    { method: 'GET', path: '/api/data', auth: 'admin', handler: async ({ ctx }) => Response.json(await ctx.kv.getJSON('data')) },
  ],
})
```

页面里：

```html
<link rel="stylesheet" href="/tokens.css" />        <!-- 与面板同色同字，跟随明暗 -->
<script type="module">
  import { createBridge } from '/bridge.js'         <!-- 协议版本永远与面板一致 -->
  const bridge = await createBridge()
  const res = await bridge.fetch('/api/data')       <!-- 自动带桥接令牌，相对路径以 /p/foo 解析 -->
  bridge.toast('已加载', 'success')
  bridge.setTitle('我的页面')
  bridge.resize()                                   <!-- 上报高度，面板自动撑开 iframe -->
  bridge.onTheme((t) => ...)
</script>
```

工作方式：

1. 面板向 `/admin/plugins/foo/bridge` 取一个 **1 小时、限定 foo** 的桥接令牌，首次通过 `?token=` 传给 iframe（iframe 首个请求带不了 Authorization 头），之后通过 postMessage 每 45 分钟刷新。面板上的「新窗口打开」同样把一枚新令牌放进 `?token=`，但新窗口里没有桥来刷新，1 小时后要回面板重新打开。
2. iframe 带 `sandbox="allow-scripts allow-forms allow-popups allow-downloads"`，没有 `allow-same-origin`，所以是 opaque origin：拿不到面板的 localStorage 与会话令牌。它对同源接口的请求按跨域处理，因此面板资源与 `/p/*` 路由都返回 `Access-Control-Allow-Origin: *`——令牌走头部不走 cookie，放开 CORS 不扩大权限。
3. 运行时对 `auth: 'admin'` 的路由接受面板会话或**本插件**的桥接令牌，其他插件的令牌一律 401。`RouteInput.authenticated` 告诉公开路由当前请求是否已登录。
4. 令牌只在 iframe 的第一个请求里（`?token=`），页面再加载的脚本、样式、图片带不上它。所以 `auth: 'admin'` 的页面要么是单个 HTML 文件（内置插件都是这样），要么把静态资源设成公开、只把 `/api/*` 设成 `auth: 'admin'`、用 `bridge.fetch` 调。
5. 有构建步骤的插件页面（Vue/React 等）用 `serveAssets('/ui/*', assets)` 托管：前端在本地构建好，转成资源表提交进仓库（构建机不跑前端构建），做法见[插件开发指南 · 自带 Web 页面](./plugin-guide.md#_8-自带-web-页面与-http-接口)。

示例：`plugins/keyboard` 的「按键点击记录」页面——回调按键把点击写进插件自己的 KV，页面通过桥读出来并可清空。

页面也可以不进面板：不写 `auth` 的路由是公开的，直接用 `https://<机器人域名>/p/<插件名>/…` 打开。这时 `createBridge()` 握手超时后按独立模式工作（`bridge.embedded` 为 false）：主题跟随系统，令牌只从地址里的 `?token=` 取，`bridge.fetch` 照样按 `/p/<插件名>` 解析相对路径。

## 本地开发

```bash
pnpm dev                       # 构建面板并启动 wrangler dev（:8787）
pnpm --filter @qqbot/ui dev    # 面板热更新（:5173，/admin 与 /p 代理到 8787）
```
