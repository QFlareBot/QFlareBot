import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseSource, resolveSource } from './gitSource.js'

const SHA = 'abc1234' + '0'.repeat(33)
const OTHER_SHA = '9'.repeat(40)

/** 按地址回放 GitHub API：commits/{ref} → sha，repos/{o}/{r} → 默认分支 */
function stubGitHub(commits: Record<string, string>, defaultBranch = 'main') {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url)
      const commit = /\/commits\/([^/]+)$/.exec(url)
      if (commit) {
        const sha = commits[decodeURIComponent(commit[1]!)]
        return sha ? Response.json({ sha }) : new Response('{}', { status: 422 })
      }
      return Response.json({ default_branch: defaultBranch })
    }),
  )
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseSource', () => {
  it('查询串与片段不算 ref，也不算子目录', () => {
    expect(parseSource('https://github.com/o/r/tree/main?tab=readme')).toMatchObject({ owner: 'o', repo: 'r', ref: 'main', sub: '' })
    expect(parseSource('https://github.com/o/r#readme')).toMatchObject({ owner: 'o', repo: 'r', ref: null, sub: '' })
    expect(parseSource('https://github.com/o/r/tree/main/plugins/foo/?x=1#y')).toMatchObject({ ref: 'main', sub: 'plugins/foo' })
  })

  it('r.git/ 先去斜杠再去 .git', () => {
    expect(parseSource('https://github.com/o/r.git/')).toMatchObject({ owner: 'o', repo: 'r', ref: null })
    expect(parseSource('o/r.git')).toMatchObject({ owner: 'o', repo: 'r' })
  })

  it('百分号编码的分支名解开；git: 来源里的 # 是子目录', () => {
    expect(parseSource('https://github.com/o/r/tree/%E5%BC%80%E5%8F%91')).toMatchObject({ ref: '开发' })
    expect(parseSource('git:o/r@ABC1234#plugins/foo/')).toEqual({ kind: 'github', owner: 'o', repo: 'r', ref: 'abc1234', sub: 'plugins/foo' })
  })

  it('认不出的 git: 来源原样交给后端；别的认不出就报错', () => {
    expect(parseSource('git:o/r@main')).toEqual({ kind: 'raw', source: 'git:o/r@main' })
    expect(() => parseSource('https://gitlab.com/o/r')).toThrow(/无法识别的来源/)
  })
})

describe('resolveSource', () => {
  it('40 位 sha 直接用，不问 GitHub', async () => {
    const calls = stubGitHub({})
    await expect(resolveSource(`https://github.com/o/r/tree/${SHA.toUpperCase()}/p`)).resolves.toEqual({ source: `git:o/r@${SHA}#p` })
    await expect(resolveSource(`git:o/r@${SHA}`)).resolves.toEqual({ source: `git:o/r@${SHA}` })
    expect(calls).toEqual([])
  })

  it('短 sha 补全成 40 位（git: 来源也一样），不当成分支提醒', async () => {
    stubGitHub({ abc1234: SHA })
    await expect(resolveSource('https://github.com/o/r/tree/abc1234')).resolves.toEqual({ source: `git:o/r@${SHA}` })
    await expect(resolveSource('git:o/r@ABC1234#p')).resolves.toEqual({ source: `git:o/r@${SHA}#p` })
  })

  it('纯十六进制名字的分支按分支解析：写进去的是它当前的 commit，并提醒以后跟默认分支走', async () => {
    stubGitHub({ deadbeef: OTHER_SHA })
    const res = await resolveSource('https://github.com/o/r/tree/deadbeef')
    expect(res.source).toBe(`git:o/r@${OTHER_SHA}`)
    expect(res.notice).toContain('链接指定了分支 deadbeef')
  })

  it('没写分支跟 HEAD；写的就是默认分支不提醒', async () => {
    const calls = stubGitHub({ HEAD: SHA, main: SHA })
    await expect(resolveSource('https://github.com/o/r.git/')).resolves.toEqual({ source: `git:o/r@${SHA}` })
    expect(calls[0]).toBe('https://api.github.com/repos/o/r/commits/HEAD')
    await expect(resolveSource('https://github.com/o/r/tree/main/plugins/foo?tab=readme')).resolves.toEqual({
      source: `git:o/r@${SHA}#plugins/foo`,
    })
  })

  it('解析失败说清楚是哪个 ref', async () => {
    stubGitHub({})
    await expect(resolveSource('https://github.com/o/r/tree/abc1234')).rejects.toThrow(/提交或分支 abc1234/)
  })
})
