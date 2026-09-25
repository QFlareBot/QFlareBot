import { describe, expect, it, vi } from 'vitest'
import { BUILDS_PAGE_SIZE, BUILD_COMMAND, CloudflareBuildsApi, DEPLOY_COMMAND, type BuildRecord } from './builds.js'
import { CloudflareApiError } from './cloudflare.js'

type Call = { url: string; init: RequestInit }

function fakeApi(responder: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} }
    calls.push(call)
    return responder(call)
  })
  const api = new CloudflareBuildsApi({
    accountId: 'acc123',
    apiToken: 'tok',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  })
  return { api, calls }
}

const ok = (result: unknown) => new Response(JSON.stringify({ success: true, errors: [], result }))

describe('CloudflareBuildsApi.triggerBuild', () => {
  it('POST 到 trigger 的 builds 接口，默认只带 branch', async () => {
    const { api, calls } = fakeApi(() => ok({ build_uuid: 'b-1' }))
    const result = await api.triggerBuild('trig-1', { branch: 'main' })
    expect(result).toEqual({ buildUuid: 'b-1' })

    const call = calls[0]!
    expect(call.url).toBe('https://api.cloudflare.com/client/v4/accounts/acc123/builds/triggers/trig-1/builds')
    expect(call.init.method).toBe('POST')
    expect((call.init.headers as Record<string, string>).authorization).toBe('Bearer tok')
    expect(JSON.parse(call.init.body as string)).toEqual({ branch: 'main' })
  })

  it('commitHash 映射为 commit_hash 字段', async () => {
    const { api, calls } = fakeApi(() => ok({ build_uuid: 'b-2' }))
    await api.triggerBuild('t', { branch: 'main', commitHash: 'abcdef1234567890' })
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ branch: 'main', commit_hash: 'abcdef1234567890' })
  })

  it('响应缺 build_uuid 时抛 CloudflareApiError', async () => {
    const { api } = fakeApi(() => ok({ unexpected: true }))
    const err = (await api.triggerBuild('t', { branch: 'main' }).catch((e: unknown) => e)) as CloudflareApiError
    expect(err).toBeInstanceOf(CloudflareApiError)
    expect(err.message).toContain('build_uuid')
  })
})

describe('CloudflareBuildsApi.listBuilds', () => {
  it('兼容数组与 { items } 两种返回', async () => {
    const records: BuildRecord[] = [
      { build_uuid: 'b1', status: 'success', branch: 'main', build_trigger_metadata: { commit_hash: 'a'.repeat(40) } },
      { build_uuid: 'b2', status: 'failed' },
    ]
    const { api, calls } = fakeApi(({ url }) => {
      // 必须带 per_page：默认页很小，账本里等回填的构建一翻页就会被当成「不存在」而误判为失败
      expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/acc123/builds/workers/bot-tag/builds?per_page=${BUILDS_PAGE_SIZE}`)
      return ok({ items: records })
    })
    expect(await api.listBuilds('bot-tag')).toEqual(records)
    expect(calls[0]!.init.method).toBe('GET')
  })

  it('失败信封抛 CloudflareApiError', async () => {
    const { api } = fakeApi(
      () => new Response(JSON.stringify({ success: false, errors: [{ code: 1, message: 'Invalid token' }], result: null }), { status: 400 }),
    )
    await expect(api.listBuilds('t')).rejects.toBeInstanceOf(CloudflareApiError)
  })
})

describe('CloudflareBuildsApi.listScripts', () => {
  it('返回 id/tag 对，兼容数组与 { items } 两种返回', async () => {
    const { api, calls } = fakeApi(({ url }) => {
      expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acc123/workers/scripts')
      return ok({ items: [{ id: 'qqbot', tag: 'bot-tag' }, { other: true }] })
    })
    expect(await api.listScripts()).toEqual([{ id: 'qqbot', tag: 'bot-tag' }])
    expect(calls[0]!.init.method).toBe('GET')
  })

  it('缺 id/tag 的条目被过滤掉', async () => {
    const { api } = fakeApi(() => ok([{ id: 'a', tag: 't1' }, { id: 'b' }, { tag: 't3' }]))
    expect(await api.listScripts()).toEqual([{ id: 'a', tag: 't1' }])
  })
})

describe('CloudflareBuildsApi.getTriggerUuid', () => {
  it('返回第一个 trigger 的 trigger_uuid', async () => {
    const { api, calls } = fakeApi(({ url }) => {
      expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acc123/builds/workers/bot-tag/triggers')
      return ok({ items: [{ trigger_uuid: 'trig-9' }] })
    })
    expect(await api.getTriggerUuid('bot-tag')).toBe('trig-9')
    expect(calls[0]!.init.method).toBe('GET')
  })

  it('仓库未连接（空列表）时返回 null 而不是抛错', async () => {
    const { api } = fakeApi(() => ok([]))
    expect(await api.getTriggerUuid('bot-tag')).toBeNull()
  })

  it('回退到 uuid / id 字段', async () => {
    const { api } = fakeApi(() => ok([{ uuid: 'u-1' }]))
    expect(await api.getTriggerUuid('t')).toBe('u-1')
    const { api: api2 } = fakeApi(() => ok({ items: [{ id: 'i-1' }] }))
    expect(await api2.getTriggerUuid('t')).toBe('i-1')
  })

  it('开了非生产分支构建时跳过排在前面的预览 trigger', async () => {
    const { api } = fakeApi(() =>
      ok([
        { trigger_uuid: 'preview', branch_includes: ['*'], branch_excludes: ['main'] },
        { trigger_uuid: 'prod', branch_includes: ['main'], branch_excludes: [] },
      ]),
    )
    expect(await api.getTriggerUuid('t')).toBe('prod')
  })

  it('只有预览 trigger 时返回 null', async () => {
    const { api } = fakeApi(() => ok([{ trigger_uuid: 'preview', branch_includes: ['*'] }]))
    expect(await api.getTriggerUuid('t')).toBeNull()
  })
})

describe('trigger 配置写入', () => {
  it('updateTrigger 走 PATCH，只带传入的字段', async () => {
    const { api, calls } = fakeApi(({ url }) => {
      expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acc123/builds/triggers/trig-1')
      return ok({})
    })
    await api.updateTrigger('trig-1', { build_command: BUILD_COMMAND, deploy_command: DEPLOY_COMMAND })
    expect(calls[0]!.init.method).toBe('PATCH')
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      build_command: BUILD_COMMAND,
      deploy_command: DEPLOY_COMMAND,
    })
  })

  it('putTriggerEnv 把清单地址与令牌写进构建环境变量，令牌标记为 secret', async () => {
    const { api, calls } = fakeApi(({ url }) => {
      expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acc123/builds/triggers/trig-1/environment_variables')
      return ok({})
    })
    await api.putTriggerEnv('trig-1', {
      MANIFEST_URL: { value: 'https://bot.example.com/admin/build-manifest', is_secret: false },
      MANIFEST_TOKEN: { value: 'tok', is_secret: true },
    })
    expect(calls[0]!.init.method).toBe('PATCH')
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      MANIFEST_URL: { value: 'https://bot.example.com/admin/build-manifest', is_secret: false },
      MANIFEST_TOKEN: { value: 'tok', is_secret: true },
    })
  })

  it('trigger uuid 做 URL 编码', async () => {
    const { api } = fakeApi(({ url }) => {
      expect(url).toContain('/builds/triggers/a%2Fb')
      return ok({})
    })
    await api.updateTrigger('a/b', { build_command: 'x' })
  })
})

describe('构建命令常量', () => {
  // 引导脚本跑在 pnpm build 之前，import 不到构建产物，只能各存一份。
  // 这条断言是那份副本的唯一约束——少了它，改了命令之后无 UI 引导会继续教用户抄旧的。
  it('scripts/bootstrap/lib.mjs 里的副本与本包定义一致', async () => {
    const { readFile } = await import('node:fs/promises')
    const url = new URL('../../../scripts/bootstrap/lib.mjs', import.meta.url)
    const source = await readFile(url, 'utf8')
    expect(source).toContain(`export const BUILD_COMMAND = '${BUILD_COMMAND}'`)
    expect(source).toContain(`export const DEPLOY_COMMAND = '${DEPLOY_COMMAND}'`)
  })
})
