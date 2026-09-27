// cron 表达式的解析与匹配在 SDK 里（@qqbot/sdk/cron）：`qqbot-plugin build` 要用同一套规则提前警告写错的表达式，
// 而构建工具不依赖运行时。这里原样重新导出，运行时各处照旧从 ./cron.js 取。
// 语义照标准 Vixie cron，时区固定 UTC，细节见 SDK 那边的注释
export { cronError, cronMatches } from '@qqbot/sdk/cron'
