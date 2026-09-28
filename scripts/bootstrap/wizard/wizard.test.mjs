import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createProvision, progressView, recordOutput, recordStep, resultView } from './provision.mjs'
import { createWizardServer } from './server.mjs'
import { createState, resumeStep, resumeView } from './state.mjs'
import { loadUi } from './ui.mjs'

describe('刷新后接着走', () => {
  it('按服务端状态依次落在 token → options → deploy → connect → builds → done', () => {
    const s = createState({})
    expect(resumeStep(s)).toBe('token')
    s.token = 't'
    expect(resumeStep(s)).toBe('options')
    s.provision = createProvision()
    expect(resumeStep(s)).toBe('deploy')
    Object.assign(s.provision, { done: true, ok: false })
    expect(resumeStep(s)).toBe('deploy') // 失败了停在部署页，可以重试
    Object.assign(s.provision, { ok: true })
    expect(resumeStep(s)).toBe('connect')
    s.builds = {}
    expect(resumeStep(s)).toBe('builds')
    s.completion = { triggerConfigured: true }
    expect(resumeStep(s)).toBe('done')
  })

  it('没验证过 token 时不透露账户；token 本身永远不回给页面', () => {
    const s = createState({ BOOT_ACCOUNT_ID: 'acc' })
    expect(resumeView(s)).toMatchObject({ accountId: null, accountName: null })
    Object.assign(s, { token: 'secret-token', accountId: 'acc', accounts: [{ id: 'acc', name: 'Me' }] })
    const view = resumeView(s)
    expect(view).toMatchObject({ step: 'options', accountId: 'acc', accountName: 'Me' })
    expect(JSON.stringify(view)).not.toContain('secret-token')
  })
})

describe('部署进度', () => {
  it('run 开一行，ok / warn / fail 收掉同名那一行并记下用时', () => {
    const p = createProvision()
    recordStep(p, '准备 KV', 'run', undefined, 1000)
    recordStep(p, '准备 KV', 'ok', undefined, 1500)
    recordStep(p, '准备 R2', 'run', undefined, 1500)
    recordStep(p, '准备 R2', 'warn', '未激活', 1800)
    expect(p.steps).toEqual([
      { name: '准备 KV', state: 'ok', detail: null, startedAt: 1000, endedAt: 1500 },
      { name: '准备 R2', state: 'warn', detail: '未激活', startedAt: 1500, endedAt: 1800 },
    ])
  })

  it('日志只留最近 400 行', () => {
    const p = createProvision()
    for (let i = 0; i < 450; i++) recordOutput(p, `line ${i}`)
    expect(p.log).toHaveLength(400)
    expect(p.log[0]).toBe('line 50')
  })

  it('给页面的结果不带 BUILD_TOKEN 的值和资源 id，后台链接拼好', () => {
    const view = resultView({
      accountId: 'acc',
      workerName: 'qqbot',
      panelUrl: 'https://qqbot.x.workers.dev/',
      manifestUrl: 'https://qqbot.x.workers.dev/admin/build-manifest',
      buildToken: 'manifest-secret',
      buildsTokenUrl: 'u1',
      buildsConnectUrl: 'u2',
      resources: { kv: { name: 'qqbot', id: 'kv-id-123', created: true }, d1: null, r2: { name: 'r2', created: false } },
      warnings: [],
    })
    expect(JSON.stringify(view)).not.toMatch(/manifest-secret|kv-id-123/)
    expect(view.resources).toEqual({ kv: { name: 'qqbot', created: true }, d1: null, r2: { name: 'r2', created: false } })
    expect(view.domainsUrl).toContain('/workers/services/view/qqbot/production/settings/triggers')
    expect(view.buildsUrl).toContain('/production/builds')
    // 旧结果没有重跑相关字段：一律按否
    expect(view).toMatchObject({ redeployed: false, adminTokenKept: false, buildsTokenExisting: false })
  })

  it('还没开始部署时是一份空进度', () => {
    expect(progressView(null, 5)).toEqual({ started: false, steps: [], log: [], done: false, ok: false, now: 5 })
  })
})

describe('页面文件与认领', () => {
  let dir
  let server
  afterEach(async () => {
    server?.close()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  async function start() {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wizard-ui-'))
    await mkdir(path.join(dir, 'assets'))
    await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>wizard</title>')
    await writeFile(path.join(dir, 'assets', 'index-abc.js'), 'console.log(1)')
    const ui = await loadUi(dir)
    const session = { id: 'sid123', cookie: null, onClaim() {} }
    const routes = { 'GET /api/init': (req, res) => res.end('{"ok":true}') }
    server = createWizardServer({ session, state: createState({}), routes, getUi: () => ui, port: 0 })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    return { base: `http://127.0.0.1:${server.address().port}`, session }
  }

  it('只按构建产物的清单回文件：带哈希的资源长缓存，其余路径 404', async () => {
    const { base } = await start()
    const js = await fetch(`${base}/assets/index-abc.js`)
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toContain('text/javascript')
    expect(js.headers.get('cache-control')).toContain('immutable')
    expect((await fetch(`${base}/assets/../../etc/passwd`)).status).toBe(404)
    expect((await fetch(`${base}/nope.js`)).status).toBe(404)
  })

  it('带 sid 的第一个浏览器拿到 Cookie；之后别人打开是锁定页，接口回 403 + gate', async () => {
    const { base, session } = await start()
    // 认领之前：没有 sid 只能看到页面壳子，接口告诉页面缺凭证
    expect((await fetch(`${base}/`)).status).toBe(403)
    expect(await (await fetch(`${base}/api/init`)).json()).toMatchObject({ gate: 'unclaimed' })

    const claim = await fetch(`${base}/?sid=sid123`)
    expect(claim.status).toBe(200)
    expect(claim.headers.get('referrer-policy')).toBe('no-referrer')
    const cookie = claim.headers.get('set-cookie').split(';')[0]
    expect(cookie).toBe(`wizard_session=${session.cookie}`)

    expect((await fetch(`${base}/api/init`, { headers: { cookie } })).status).toBe(200)
    // 别的浏览器，哪怕带着同一个 sid
    expect((await fetch(`${base}/?sid=sid123`)).status).toBe(403)
    expect(await (await fetch(`${base}/api/init`)).json()).toMatchObject({ gate: 'locked' })
    expect(await (await fetch(`${base}/api/init`, { headers: { cookie: 'wizard_session=forged' } })).json()).toMatchObject({ gate: 'locked' })
  })
})
