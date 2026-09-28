/**
 * 引导部署核心库（headless.mjs 与 wizard.mjs 共用）。按职责拆在 lib/ 下，这里统一导出。
 *
 * 职责：校验 API token → 推导账户 → 幂等创建/复用 KV / D1 / R2 → 构建 + 部署 Worker
 * （环境变量动态注入基础设施绑定，零 Git 污染）→ wrangler secret bulk 写入运行时密钥。
 * QQ 机器人不在引导里建：部署完到面板「设置」里扫码创建或填入已有的凭证。
 *
 * 设计约束：
 * - 幂等：资源按名字查到即复用；重跑只补缺，零 Git 污染
 * - token 只经环境变量/内存传递，绝不打印、绝不落盘
 * - R2 创建失败（未激活/无权限）降级为去掉 R2 绑定而不是整体失败
 * - 公开仓库的 Actions 日志与 Step Summary 谁都能看：账户 ID、workers.dev 子域、资源 id 一拿到就
 *   打码（maskInLog）；事先不知道的（报错里的 trigger / build uuid、部署打印的 Version ID）按形状过滤
 *   （redactApiPath / redactIds）；Summary 用 renderSummary 的 publicView 渲染，不带任何地址与标识
 *
 *   lib/redact.mjs       公开日志打码
 *   lib/cf.mjs           Cloudflare REST、token / 账户 / 权限 / 子域查询
 *   lib/resources.mjs    KV / D1 / R2 与已安装插件
 *   lib/secrets.mjs      管理密钥规则、BUILD_TOKEN、写 Worker secret
 *   lib/deploy.mjs       构建并部署 Worker
 *   lib/builds.mjs       构建命令、排除路径、Workers Builds 接口
 *   lib/links.mjs        Cloudflare 后台预填链接
 *   lib/summary.mjs      Markdown 汇总
 *   lib/cloudflared.mjs  Quick Tunnel 用的 cloudflared
 *   lib/bootstrap.mjs    完整引导流程
 */

export * from './lib/redact.mjs'
export * from './lib/cf.mjs'
export * from './lib/resources.mjs'
export * from './lib/secrets.mjs'
export * from './lib/deploy.mjs'
export * from './lib/builds.mjs'
export * from './lib/links.mjs'
export * from './lib/summary.mjs'
export * from './lib/cloudflared.mjs'
export * from './lib/bootstrap.mjs'
