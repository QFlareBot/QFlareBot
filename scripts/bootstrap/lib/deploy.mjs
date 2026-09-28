/** 构建并部署 Worker：子进程执行 pnpm / wrangler，输出逐行打码后再进日志 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { BootstrapError } from './cf.mjs'
import { redactIds } from './redact.mjs'

/** 逐行过一遍 redactIds 再打印；onLine 另收一份（网页向导的「详细日志」） */
function pipeRedacted(input, output, onLine) {
  createInterface({ input, crlfDelay: Infinity }).on('line', (line) => {
    const clean = redactIds(line)
    output.write(`${clean}\n`)
    onLine?.(clean)
  })
}

/**
 * redact：子进程的输出逐行遮掉标识再打印。wrangler deploy 部署完会打印 `Current Version ID: <uuid>`，
 * 这个值部署时才生成，没法像子域、资源 id 那样事先 add-mask。
 * 子进程的 close 在它的输出流都结束之后才触发，最后一行不会丢。
 */
function runAsync(cmd, args, { cwd, env = {}, redact = false, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: redact ? ['inherit', 'pipe', 'pipe'] : 'inherit',
      env: { ...process.env, ...env },
    })
    if (redact) {
      pipeRedacted(child.stdout, process.stdout, onLine)
      pipeRedacted(child.stderr, process.stderr, onLine)
    }
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) reject(new BootstrapError(`命令失败（退出码 ${code}）：${cmd} ${args.join(' ')}`))
      else resolve()
    })
  })
}

/**
 * 构建机脚本（apps/seed/scripts/build-deploy.mjs）的环境变量。
 *
 * - 没有 D1 / R2（选了 none、R2 未激活降级）就明确传 `none`：缺省会被当成「没解析出来」，
 *   重新部署走的正常路径有护栏，会拒绝部署；首次部署时两者生成的配置一样（都不绑）。
 * - Worker 还不存在才走 INITIAL_BOOTSTRAP（wrangler deploy 建脚本、workers.dev 与 Cron）；
 *   已经部署过的走 Versions API：先在预览地址做健康检查、校验 secret 没丢，通过了才切流量，
 *   再由 BOOTSTRAP_REDEPLOY 同步一次 Cron 与 workers.dev（Versions API 不碰脚本级设置）。
 */
export function deployEnv({ token, accountId, workerName, bindings = {}, manifestFile, redeploy = false }) {
  return {
    CLOUDFLARE_API_TOKEN: token,
    CLOUDFLARE_ACCOUNT_ID: accountId,
    ...(workerName ? { CF_WORKER_NAME: workerName } : {}),
    ...(bindings.kvId ? { CF_KV_ID: bindings.kvId } : {}),
    CF_D1_ID: bindings.d1Id || 'none',
    CF_R2_NAME: bindings.r2Name || 'none',
    ...(manifestFile ? { MANIFEST_FILE: manifestFile } : {}),
    ...(redeploy ? { BOOTSTRAP_REDEPLOY: 'true' } : { INITIAL_BOOTSTRAP: 'true' }),
  }
}

/**
 * installedPlugins：D1 里已安装的插件集，写成文件经 MANIFEST_FILE 交给 prepare，与内置清单合并构建。
 * undefined = 这次没有 D1，只用内置清单。
 * redeploy：Worker 已经存在（重跑引导），见 deployEnv。
 * onOutput：可选，构建与部署输出（已打码）逐行回调。
 */
export async function buildAndDeploy({ repoRoot, token, accountId, workerName, bindings = {}, installedPlugins, redeploy = false, onOutput }) {
  const manifestFile = installedPlugins
    ? path.join(os.tmpdir(), `qqbot-installed-plugins-${randomBytes(6).toString('hex')}.json`)
    : undefined
  if (manifestFile) await writeFile(manifestFile, JSON.stringify({ plugins: installedPlugins }))
  const env = deployEnv({ token, accountId, workerName, bindings, manifestFile, redeploy })
  try {
    await runAsync('pnpm', ['install', '--frozen-lockfile'], { cwd: repoRoot })
    // 部署输出里有部署时才生成的 Version ID，过滤后再进日志（子域、资源 id 在这之前已经 add-mask）
    await runAsync('pnpm', ['--filter', '@qqbot/seed', 'run', 'deploy:manifest'], { cwd: repoRoot, env, redact: true, onLine: onOutput })
  } finally {
    if (manifestFile) await rm(manifestFile, { force: true })
  }
}
