/**
 * 把用户给的插件来源解析成钉在 commit 上的 git: 来源。插件页的安装框与插件市场共用。
 * 在浏览器里匿名调 GitHub API：每个 IP 每小时 60 次，够面板用；Worker 端改走 commits.atom（共享出口 IP 会被打爆）。
 */

/**
 * GitHub 链接 / owner/repo → 解析 ref 的最新 commit；git: 原样交给后端校验。
 * notice：链接写了默认分支以外的分支时给的提醒——装的是那个分支，以后更新却跟默认分支走，不说一声就是悄悄换代码
 */
export async function resolveSource(raw: string): Promise<{ source: string; notice?: string }> {
  const s = raw.trim().replace(/\.git$/, '').replace(/\/+$/, '')
  if (s.startsWith('git:')) return { source: s }
  let m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)(?:\/tree\/([^/\s]+)?([^#\s]*))?(?:[?#].*)?$/i.exec(s)
  if (!m) m = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(s)
  if (!m) throw new Error('无法识别的来源。支持 GitHub 链接、owner/repo 或 git:owner/repo@commit[#子目录]')
  // 没写分支就跟默认分支走（GitHub API 认 HEAD），与检查更新用的 commits.atom 一致；写死 main 的话默认分支叫 master 的仓库会 422
  const [, owner, repo, ref = 'HEAD', sub = ''] = m
  if (!owner || !repo) throw new Error('无法识别的来源。支持 GitHub 链接、owner/repo 或 git:owner/repo@commit[#子目录]')
  const isSha = /^[0-9a-f]{7,40}$/i.test(ref)
  const branch = isSha || ref === 'HEAD' ? null : ref
  const [sha, defaultBranch] = await Promise.all([isSha ? ref : resolveSha(owner, repo, ref), branch ? defaultBranchOf(owner, repo) : null])
  const source = `git:${owner}/${repo}@${sha}${sub ? `#${sub.replace(/^\//, '')}` : ''}`
  // monorepo 的子目录链接几乎都带 /tree/<默认分支>/，那种不提醒，否则每次都是噪音
  if (!branch || branch === defaultBranch) return { source }
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

async function resolveSha(owner: string, repo: string, ref: string): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`, {
    headers: { accept: 'application/vnd.github+json' },
  })
  if (!res.ok) {
    const what = ref === 'HEAD' ? '默认分支' : `分支 ${ref} `
    throw new Error(`解析${what}的最新 commit 失败（HTTP ${res.status}）：仓库或分支不存在，或是私有仓库（只支持公开的 GitHub 仓库）`)
  }
  const data = (await res.json()) as { sha?: string }
  if (!data.sha) throw new Error('GitHub 响应缺少 sha')
  return data.sha
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
