# QFlareBot 设计规范

面板（`@qqbot/ui`）与插件页面共用这一套。机器可读版本是 `packages/ui-bridge/src/tokens.css`：页面只用那里的 `--qb-*` 变量，不写死颜色。

**风格：柔光。** 带一点绿的中性底色，上面浮着白色卡片和半透明侧栏；靠柔和阴影而不是边框分层，圆角偏大，按钮是胶囊形。

**档位：** 变化 3/10（布局规整） · 动效 5/10（有，但只在状态变化时） · 密度 6/10（管理面板，留白比默认后台多一点）

---

## 颜色

两套主题共用同一组语义变量，由 `<html data-theme>` 切换，未设置时跟随系统。

| 角色 | 变量 | 浅色 | 深色 |
|------|------|------|------|
| 页面底色 | `--qb-bg` | `#E9EEEA`（加两团光晕 `--qb-bg-glow`） | `#0B0F0D` |
| 卡片 | `--qb-surface` | `#FFFFFF` | `#141A17` |
| 次级填充（代码块、中性徽标） | `--qb-surface-muted` | `#F0F4F1` | `#1C231F` |
| 输入框底 | `--qb-input` | `#F6F8F7` | `#111613` |
| 正文 | `--qb-fg` | `#18211C` | `#E7EDE9` |
| 次要文字 | `--qb-fg-muted` | `#5D6A63` | `#97A39C` |
| 更弱的文字 | `--qb-fg-subtle` | `#8E9A93` | `#6A766F` |
| 分隔线 | `--qb-border` | `#E6EBE7` | `#222A26` |
| 控件边框 | `--qb-border-strong` | `#D2DAD4` | `#313B35` |
| 强调色（主按钮、开关、选中） | `--qb-accent` | `#16A34A` | `#2FCA6A` |
| 焦点环 | `--qb-ring` | `#15803D` | `#4ADE80` |

**状态色三档，旁边必须有文字或图标**，不靠颜色单独传达：成功 `--qb-success`、警告 `--qb-warning`、失败 `--qb-danger`，各有一个浅底 `*-bg` 用于徽标和提示条。浅色下三者都压到了 4.5:1 以上。

强调色只有一个（品牌绿），用于主按钮、开关打开、侧栏里的状态点；其余交互用前景色的深浅表达。

## 层次

| 层 | 做法 |
|----|------|
| 卡片 | `--qb-surface` + `--qb-shadow`（柔和两层阴影），边框只是极淡的 `--qb-card-border` |
| 可点的卡片 | 悬停上移 2px，换 `--qb-shadow-hover`；不可点的卡片不做悬停效果 |
| 侧栏、手机顶栏、抽屉 | 半透明 `--qb-glass` + `backdrop-filter` 模糊；不支持模糊或用户要求减少透明度时换成实色 |
| 对话框、toast | `--qb-shadow-overlay`，遮罩 `--qb-overlay` |

## 字体与字号

不加载 webfont（大陆可用性是硬约束，面板不引任何外部资源）：

- 正文：`system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif`
- 等宽（id、hash、日志）：`ui-monospace, "SF Mono", Menlo, Consolas, monospace`

字号 12 / 13 / 14 / 16 / 20 / 24：正文 14，辅助 12（不低于 12），页面标题 24，统计数字 24 且用 `tabular-nums`。

## 形状与间距

- 圆角：控件 10px（`--qb-radius`），卡片 16px（`--qb-radius-lg`），对话框 20px，按钮与徽标是胶囊（`--qb-radius-full`）
- 间距刻度 4 / 8 / 12 / 16 / 20 / 24 / 32；卡片内边距 16，卡片之间 16
- 控件高 32，表格行高 40，触控目标不小于 44

## 动效

时长 `--qb-duration`（160ms，悬停、按下）、`--qb-duration-slow`（320ms，展开、遮罩）、`--qb-duration-slower`（480ms，入场）；曲线 `--qb-ease`、`--qb-ease-out`、`--qb-ease-spring`（带一点回弹，只用于小元素：开关圆钮、选中块、对话框、徽标）。

| 场景 | 做法 |
|------|------|
| 切页 | 旧页淡出上移 4px；新页各块依次上浮 8px，间隔 40ms |
| 侧栏选中 | 选中块滑到新位置 |
| 按钮 | 按下缩到 0.97 |
| 开关 | 按住时圆钮拉长，松开弹到另一侧 |
| 对话框 | 遮罩淡入，面板从 0.96 放大上浮 |
| 手机抽屉 | 从左侧滑入 |
| toast | 桌面从右下、手机从顶栏下方滑入，底边进度条表示剩余时间 |
| 新数据 | 新出现的表格行淡入并短暂高亮 |
| 进行中 | 状态点外扩一圈光晕（实时调试、构建中），提示条底边不定进度条 |
| 加载 | 骨架屏，不只放一行"正在读取…" |
| 折叠 | 行高过渡（`QCollapse`） |

只动 `opacity` / `transform`（折叠例外）。系统开了「减弱动态效果」时 token 归零、循环动画停掉。不引 GSAP 等动画库。

## 布局

- **桌面（≥768px）**：左侧 240px 的浮动半透明侧栏，内容区最宽 1152px。页面跟着文档滚动。
- **手机**：顶栏（菜单按钮 + 标志 + 机器人状态）+ 左侧抽屉。**底部不放任何固定元素**：iOS 26 的 Safari 底栏是悬浮的，贴底的 fixed 元素会被画偏或挡住；toast 也放在顶栏下方。四周按 `env(safe-area-inset-*)` 留边。

## 组件

基础组件在 `packages/ui/src/components/ui/`：`QButton`（primary / secondary / ghost / danger 浅红 / destructive 实心红）、`QCard`、`QBadge`、`QInput` / `QSelect` / `QTextarea`（共用 `.qb-control`）、`QSwitch`、`StatusDot`、`QEmpty`、`QSkeleton`、`QCollapse`、`QDialog`。

**确认一律用 `useConfirm()`**，不用浏览器的 `confirm()`：危险操作红色按钮、默认聚焦「取消」，可带一条警告和一个勾选项（如「同时清空数据」）。

## 插件页面

插件页面在 iframe 里，引 `/tokens.css` 即拿到同一组 `--qb-*` 变量，`.qb-page` / `.qb-card` / `.qb-btn` / `.qb-input` 是最小基线。**变量名只增不改**，已发布插件的页面靠它们跟随面板换风格。

## 交付前检查

- [ ] 图标全用 lucide，不用 emoji
- [ ] 可点击的元素有 `cursor-pointer` 和悬停态
- [ ] 浅色、深色都看过，文字对比度 4.5:1 以上
- [ ] 键盘焦点可见；对话框和抽屉能用 Esc 关、焦点困在里面
- [ ] `prefers-reduced-motion` 下没有动画
- [ ] 375 / 768 / 1024 / 1440 宽度都看过，手机无横向滚动、底部无固定元素
