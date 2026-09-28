/** Worker 的运行时密钥：管理密钥的规则、BUILD_TOKEN 沿用还是新生成、wrangler secret bulk 写入 */

import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { BootstrapError, cfFetch } from './cf.mjs'

/** 面板登录密钥的最短长度：面板挂在公网上，太短的密码经不起猜 */
export const ADMIN_TOKEN_MIN_LENGTH = 12

/**
 * 管理密钥必须由用户自己给，引导不代为生成。
 *
 * 生成出来的值没有安全的途径交到用户手上：公开仓库的 Actions 日志与 Step Summary
 * 谁都能看，向导页面也只是一条临时隧道。用户自己定、自己记，引导全程只把它写进
 * Worker Secret，不回显、不输出。
 *
 * @returns {string | null} 不合格时的说明；合格为 null
 */
export function adminTokenProblem(token) {
  if (!token) return '缺少管理密钥 ADMIN_TOKEN：它就是面板登录密码，请自己设置一个（引导不会代为生成）'
  if (token.length < ADMIN_TOKEN_MIN_LENGTH) {
    return `管理密钥至少 ${ADMIN_TOKEN_MIN_LENGTH} 个字符：面板在公网上，太短的密码容易被猜中`
  }
  return null
}

/** Worker 上已有的 secret 名（值本来也读不到） */
export async function listWorkerSecretNames(token, accountId, workerName) {
  const result = await cfFetch(token, `/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}/secrets`)
  return (result ?? []).map((s) => s.name)
}

/**
 * 这个名字的 Worker 部署过没有，上面有哪些 secret。重跑引导靠它决定走哪条部署路径、
 * 哪些东西沿用（管理密钥、构建 token）。脚本不存在时 Cloudflare 回 404；其余失败照常抛，不猜。
 *
 * @returns {Promise<{ exists: boolean, secretNames: string[] }>}
 */
export async function inspectWorker(token, accountId, workerName) {
  try {
    return { exists: true, secretNames: await listWorkerSecretNames(token, accountId, workerName) }
  } catch (err) {
    if (err instanceof BootstrapError && err.status === 404) return { exists: false, secretNames: [] }
    throw err
  }
}

/**
 * 这次该给 Worker 写哪个 BUILD_TOKEN。
 *
 * 它在构建 trigger 的 MANIFEST_TOKEN 里有一份副本，而 Worker 往 trigger 写只写一次（KV 打标）。
 * 所以 Worker 上已经有了就**沿用、不轮换**：重跑换掉它，trigger 那份不会跟着变，之后每次构建
 * 拉清单都 401、硬失败。显式给了（BUILD_TOKEN secret）才覆盖——那是用户自己在对齐两边。
 *
 * @returns {{ value: string, reused: false } | { value: null, reused: true }}
 */
export function resolveBuildToken({ explicit, existingSecretNames }) {
  if (explicit) return { value: explicit, reused: false }
  if (existingSecretNames.includes('BUILD_TOKEN')) return { value: null, reused: true }
  return { value: randomBytes(32).toString('base64url'), reused: false }
}

/** 部署后写 Worker secrets（wrangler secret bulk，stdin 传 JSON）；token 仅用于 wrangler 鉴权 */
export function writeSecrets({ repoRoot, secrets, token, accountId, workerName }) {
  const entries = Object.entries(secrets).filter(([, v]) => typeof v === 'string' && v.length > 0)
  if (!entries.length) return
  const payload = JSON.stringify(Object.fromEntries(entries))
  const seedDir = path.join(repoRoot, 'apps', 'seed')
  const args = ['exec', 'wrangler', 'secret', 'bulk']
  if (workerName) args.push('--name', workerName)
  const r = spawnSync('pnpm', args, {
    cwd: seedDir,
    input: payload,
    stdio: ['pipe', 'inherit', 'inherit'],
    env: {
      ...process.env,
      CLOUDFLARE_API_TOKEN: token,
      ...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}),
    },
  })
  if (r.status !== 0) throw new BootstrapError('wrangler secret bulk 失败')
}
