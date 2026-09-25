#!/usr/bin/env node
/**
 * 在子进程里构建一个 git 插件，由 plugin-build.mjs 调用，不直接用。
 *
 * 抽清单要在 Node 里执行插件入口：插件自己的代码、连同它依赖的顶层代码都会跑。放进子进程、
 * 用去掉了凭证的环境变量启动（见 deploy-policy.mjs 的 scrubbedEnv），它们就读不到构建机上的令牌。
 * 这不是沙箱：文件系统照样碰得到，装的插件与它的依赖仍然得是可信代码。
 *
 * 结果写进结果文件（成功是 buildPlugin 的返回值，失败是 { error }），不走 stdout——
 * stdout / stderr 留给 esbuild 的告警，原样进构建日志。
 *
 * 用法：node scripts/build-plugin.mjs <插件目录> <结果文件>
 */
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { buildPlugin } from '@qqbot/plugin-cli'

const [cwd, resultFile] = process.argv.slice(2)
if (!cwd || !resultFile) {
  console.error('用法：node scripts/build-plugin.mjs <插件目录> <结果文件>')
  process.exit(2)
}

// SDK 一律用机器人仓库这一份：插件自己装的（或者写成 file:../ 的）不算数，契约只能有一个版本
let sdkEntry
try {
  sdkEntry = fileURLToPath(import.meta.resolve('@qqbot/sdk'))
} catch {}

try {
  const result = await buildPlugin({ cwd, ...(sdkEntry ? { alias: { '@qqbot/sdk': sdkEntry } } : {}) })
  await writeFile(resultFile, JSON.stringify(result))
} catch (err) {
  await writeFile(resultFile, JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
  process.exitCode = 1
}
