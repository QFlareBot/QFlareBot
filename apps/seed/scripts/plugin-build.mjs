/**
 * 构建机上的单个插件：装依赖、在子进程里打包。build-deploy.mjs 的 prepare 逐个调用。
 *
 * 插件的源码解包在机器人仓库**外面**（系统临时目录）：打包时只解析得到插件自己声明、自己装的依赖，
 * 不会再碰巧用上机器人仓库里装着的包——那样换一台机器人就构建不过，版本也不是作者锁定的那一份。
 * 判断逻辑在 deploy-policy.mjs（可单测），这里只管副作用。
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  TransientBuildError,
  explainBuildError,
  isTransientInstallFailure,
  planDependencyInstall,
  scrubbedEnv,
  tailLines,
} from './deploy-policy.mjs'

const CHILD_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'build-plugin.mjs')
/** 装依赖的上限：Workers Builds 会缓存 npm / pnpm 的下载，正常远用不了这么久 */
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000
const BUILD_TIMEOUT_MS = 3 * 60 * 1000
/**
 * 装依赖遇到网络问题时一共试几次。超时被杀的那种不再重试：已经等了 INSTALL_TIMEOUT_MS，
 * 再来两轮就逼近 Workers Builds 的总时限了。
 */
const INSTALL_ATTEMPTS = 3

/** 解包插件源码的目录：在机器人仓库之外 */
export const PLUGIN_WORK_DIR = path.join(os.tmpdir(), 'qqbot-build-plugins')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 按插件自己的 lockfile 装依赖，返回装了哪些包（没有第三方依赖就不装，返回空数组）。
 * 只装 dependencies、不跑安装脚本；环境变量去掉凭证。失败时把包管理器输出的最后几行放进错误。
 *
 * 网络类失败（连不上源、源站 5xx、超时）重试几次，仍然不行就抛 TransientBuildError：那是构建环境的问题，
 * 不该记到插件头上（见 deploy-policy.mjs 的 TransientBuildError）。
 */
export async function installPluginDependencies(pluginDir) {
  let pkg = null
  try {
    pkg = JSON.parse(await readFile(path.join(pluginDir, 'package.json'), 'utf8'))
  } catch {
    // 没有或读不了 package.json：交给 buildPlugin 去报它自己的错
    return []
  }
  const plan = planDependencyInstall(pkg, new Set(await readdir(pluginDir)))
  if (plan.action === 'skip') return []
  if (plan.action === 'error') throw new Error(plan.message)

  process.stdout.write(`\n  安装依赖（${plan.command} ${plan.args.join(' ')}）：${plan.packages.join('、')}…`)
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync(plan.command, plan.args, {
        cwd: pluginDir,
        env: scrubbedEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        timeout: INSTALL_TIMEOUT_MS,
      })
      return plan.packages
    } catch (err) {
      const output = tailLines(`${err.stdout ?? ''}\n${err.stderr ?? ''}`)
      // spawnSync 超时被杀时 error.code 是 ETIMEDOUT
      const timedOut = err.code === 'ETIMEDOUT'
      const message = `安装依赖失败（${plan.manager}）：${output || err.message}`
      if (!isTransientInstallFailure(output, { timedOut })) throw new Error(message)
      if (timedOut || attempt >= INSTALL_ATTEMPTS) {
        throw new TransientBuildError(
          timedOut ? `安装依赖超时（${plan.manager}，${INSTALL_TIMEOUT_MS / 60000} 分钟）：${output || err.message}` : `${message}（已试 ${attempt} 次）`,
          { cause: err },
        )
      }
      process.stdout.write(`\n  安装依赖遇到网络问题，${attempt * 3} 秒后重试（${attempt}/${INSTALL_ATTEMPTS}）…`)
      await sleep(attempt * 3000)
    }
  }
}

/**
 * 在子进程里打包并抽清单（见 build-plugin.mjs）。返回 buildPlugin 的结果：
 * { manifest, outFile, size, thirdPartyPackages }。
 */
export async function buildPluginIsolated(pluginDir) {
  const resultFile = path.join(os.tmpdir(), `qqbot-build-result-${process.pid}-${randomUUID()}.json`)
  try {
    try {
      execFileSync(process.execPath, [CHILD_SCRIPT, pluginDir, resultFile], {
        env: scrubbedEnv(),
        stdio: ['ignore', 'inherit', 'inherit'],
        timeout: BUILD_TIMEOUT_MS,
      })
    } catch {
      // 失败的原因在结果文件里；连结果文件都没有，才是子进程自己崩了或超时
    }
    let result
    try {
      result = JSON.parse(await readFile(resultFile, 'utf8'))
    } catch {
      throw new Error('构建插件的子进程没有产出结果（崩溃或超时），详见上方构建日志')
    }
    if (result.error) throw new Error(explainBuildError(result.error))
    return result
  } finally {
    await rm(resultFile, { force: true })
  }
}
