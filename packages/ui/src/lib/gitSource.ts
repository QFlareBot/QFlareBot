/**
 * 把用户给的插件来源解析成钉在 commit 上的 git: 来源。插件页的安装框与插件市场共用。
 * 在浏览器里匿名调 GitHub API：每个 IP 每小时 60 次，够面板用；Worker 端改走 commits.atom（共享出口 IP 会被打爆）。
 */

const UNRECOGNIZED = '无法识别的来源。支持 GitHub 链接、owner/repo 或 git:owner/repo@commit[#子目录]'

/** 与运行时 manifestStore.ts 的 GIT_SOURCE 同形，只是 sha 放宽大小写：这里要把短 sha 补全、大写转小写 */
const GIT_SOURCE = /^git:([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9._-]+)@([0-9a-fA-F]{7,40})(?:#([^#\s]+))?$/
const GITHUB_URL = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)(?:\/tree(?:\/([^/]+)(\/.*)?)?)?$/i
const OWNER_REPO = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/
const FULL_SHA = /^[0-9a-f]{40}$/i
const HEX_REF = /^[0-9a-f]{7,40}$/i

export type ParsedSource =
  /** 形状不认识的 git: 来源：原样交给后端，由它给出准确的报错 */
  | { kind: 'raw'; source: string }
  /** ref 为 null 表示没写分支，跟默认分支走（GitHub API 认 HEAD） */
  | { kind: 'github'; owner: string; repo: string; ref: string | null; sub: string }

/** 只做字符串解析，不发请求 */
export function parseSource(raw: string): ParsedSource {
  const s = raw.trim()
  if (s.startsWith('git:')) {
    // git: 来源里 # 后面是子目录，不能当片段去掉
    const git = s.replace(/\/+$/, '')
    const m = GIT_SOURCE.exec(git)
    if (!m) return { kind: 'raw', source: git }
    const [, owner, repo, sha, sub = ''] = m
    return { kind: 'github', owner: owner!, repo: repo!, ref: sha!.toLowerCase(), sub }
  }
  // 查询串与片段不是路径的一部分：/tree/main?tab=readme、#readme 以前会被当成 ref 或子目录的一截。
  // 先去掉它们，再去尾部斜杠，最后才去 .git——r.git/ 要先去斜杠才露出 .git
  const path = s.replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '')
  const m = GITHUB_URL.exec(path) ?? OWNER_REPO.exec(path)
  if (!m) throw new Error(UNRECOGNIZED)
  const [, owner, repo, ref, sub = ''] = m
  if (!owner || !repo) throw new Error(UNRECOGNIZED)
  return { kind: 'github', owner, repo, ref: ref ? decodeSegment(ref) : null, sub: sub.replace(/^\/+/, '') }
}

/** 从地址栏复制的链接里，中文分支名是百分号编码的；不解开的话 resolveSha 会再编码一遍 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/**
 * GitHub 链接 / owner/repo → 解析 ref 的最新 commit；git: 来源的短 sha 同样补全成 40 位。
 *
 * 只有完整的 40 位 sha 直接用，其余一律问 GitHub：纯十六进制的 ref 也可能是分支或 tag 名，原样写进去的话
 * 以后每次重建都会拉到那个分支的新代码；短 sha 写进去，「线上是否一致」按字符串比对也会误判。
 *
 * notice：链接写了默认分支以外的分支时给的提醒——装的是那个分支，以后更新却跟默认分支走，不说一声就是悄悄换代码
 */
export async function resolveSource(raw: string): Promise<{ source: string; notice?: string }> {
  const parsed = parseSource(raw)
  if (parsed.kind === 'raw') return { source: parsed.source }
  const { owner, repo, sub } = parsed
  const ref = parsed.ref ?? 'HEAD'
  const hexLike = HEX_REF.test(ref)
  // 明显是分支名的，默认分支和 commit 一起查；十六进制的要等解析完才知道是不是分支
  const defaultBranchEarly = !hexLike && ref !== 'HEAD' ? defaultBranchOf(owner, repo) : null
  const sha = FULL_SHA.test(ref) ? ref.toLowerCase() : await resolveSha(owner, repo, ref)
  // 十六进制的 ref 解析出的 commit 以它开头就是短 sha；否则是恰好长成十六进制的分支 / tag 名
  const isCommit = hexLike && sha.toLowerCase().startsWith(ref.toLowerCase())
  const branch = isCommit || ref === 'HEAD' ? null : ref
  const source = `git:${owner}/${repo}@${sha}${sub ? `#${sub}` : ''}`
  if (!branch) return { source }
  const defaultBranch = await (defaultBranchEarly ?? defaultBranchOf(owner, repo))
  // monorepo 的子目录链接几乎都带 /tree/<默认分支>/，那种不提醒，否则每次都是噪音
  if (branch === defaultBranch) return { source }
  const follows = defaultBranch ? `默认分支 ${defaultBranch}` : `仓库的默认分支（${branch} 就是默认分支的话可以忽略）`
  return { source, notice: `链接指定了分支 ${branch}：这次装的是它的最新提交，但以后检查更新、一键更新都会跟${follows}走，不会跟 ${branch}` }
}

/** 仓库默认分支；查不到返回 null——不挡安装，只影响提醒措辞 */
async function defaultBranchOf(owner: string, repo: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: { accept: 'application/vnd.github+json' } })
    if (!res.ok) return null
    const data = (await res.json()) as { default_branch?: unknown }
    return typeof data.default_branch === 'string' ? data.default_branch : null
  } catch {
    return null
  }
}

/** 分支、tag、短 sha → 40 位 commit sha（GitHub 的 commits/{ref} 三种都认） */
async function resolveSha(owner: string, repo: string, ref: string): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`, {
    headers: { accept: 'application/vnd.github+json' },
  })
  if (!res.ok) {
    const what = ref === 'HEAD' ? '默认分支' : HEX_REF.test(ref) ? `提交或分支 ${ref} ` : `分支 ${ref} `
    throw new Error(`解析${what}的最新 commit 失败（HTTP ${res.status}）：仓库或分支不存在，或是私有仓库（只支持公开的 GitHub 仓库）`)
  }
  const data = (await res.json()) as { sha?: unknown }
  if (typeof data.sha !== 'string' || !FULL_SHA.test(data.sha)) throw new Error('GitHub 响应缺少 sha')
  return data.sha.toLowerCase()
}

/** 最多同时 limit 个：每一项都要打 GitHub，一下全发出去没必要 */
export async function eachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item)
    }),
  )
}
