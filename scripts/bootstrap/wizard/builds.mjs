/**
 * 连接仓库之后的事：检测连接、写构建配置、补跑一次构建、报构建进度，以及验证构建 token。
 * 连接由主 token 自动检测，检测到就把构建命令与清单环境变量写进 trigger，Cloudflare 后台不用手填。
 */

import { randomBytes } from 'node:crypto'
import {
  BootstrapError,
  findWorkerTag,
  getBuild,
  latestBuildOutcome,
  listTriggerEnv,
  listTriggers,
  pickProductionTrigger,
  planTriggerSetup,
  setTriggerEnv,
  startBuild,
  updateTriggerSettings,
  workerBuildsUrl,
  writeSecrets,
} from '../lib.mjs'
import { log, mask } from './log.mjs'

export function createBuilds({ state, repoRoot }) {
  /**
   * 仓库连上之后一次做完：把构建命令与清单环境变量写进 trigger → 补跑一次构建。
   *
   * 连接那一刻 Cloudflare 若自己跑了一次构建，用的是表单里的命令、也还没有清单变量，注定失败；
   * 配好之后补跑这一次，用户当场就能看到构建链路通不通，不用等到面板里装插件。
   * 重跑引导时 trigger 多半早就配好了：配置一致、上次构建成功就什么都不写、不补跑（见 planTriggerSetup）。
   *
   * `token` 平时是主 token（第 ④ 步检测到连接时）；主 token 没写成时，「完成引导」会拿构建 token
   * 再试一次——两者都带 Workers 构建配置权限。写配置失败不算引导失败：Worker 已经部署好，
   * Summary 里有手填清单。
   */
  async function setupTrigger(token) {
    const b = state.builds
    const { result } = state.provision
    // 读不到现状（权限、网络）就按「不确定」处理：照首次那样全写、补跑，不会比以前差
    const env = await listTriggerEnv(token, state.accountId, b.trigger.uuid).catch((err) => {
      log(`读取构建变量失败：${err.message}`)
      return null
    })
    const lastOutcome = await latestBuildOutcome(token, state.accountId, b.tag, b.trigger.uuid).catch((err) => {
      log(`读取构建记录失败：${err.message}`)
      return null
    })
    const plan = planTriggerSetup({ trigger: b.trigger, env, manifestUrl: result.manifestUrl, buildToken: result.buildToken, lastOutcome })
    // 引导沿用了 Worker 上已有的 BUILD_TOKEN 时手里没有它的值，trigger 上又对不上时写不了 MANIFEST_TOKEN。
    // 就地换一个新值：先写 trigger，成功了才写 Worker；trigger 没写成就两边都不动，原来的值仍然对齐
    const rotated = plan.manifestToken === 'rotate' ? randomBytes(32).toString('base64url') : null
    mask(rotated)
    try {
      if (plan.updateSettings) await updateTriggerSettings(token, state.accountId, b.trigger.uuid, b.trigger.pathExcludes)
      await setTriggerEnv(token, state.accountId, b.trigger.uuid, {
        manifestUrl: plan.updateUrl ? result.manifestUrl : undefined,
        buildToken: plan.manifestToken === 'write' ? result.buildToken : (rotated ?? undefined),
      })
      if (rotated) {
        writeSecrets({ repoRoot, token: state.token, accountId: state.accountId, workerName: state.workerName, secrets: { BUILD_TOKEN: rotated } })
        Object.assign(result, { buildToken: rotated, buildTokenReused: false })
      }
    } catch (err) {
      b.error = `写入构建配置失败：${err.message}`
      log(b.error)
      return
    }
    b.configured = true
    b.error = null
    b.apiToken = token // 查构建进度沿用写得进配置的这个 token
    if (!plan.startBuild) {
      b.unchanged = true
      log('构建配置与上次一致、上次构建成功：不改动，也不补跑构建')
      return
    }
    log('构建配置（命令、清单环境变量与排除路径）已写入 trigger')
    try {
      b.buildUuid = await startBuild(token, state.accountId, b.trigger.uuid, b.trigger.branch)
      b.buildStartedAt = Date.now()
      log(`已触发构建（分支 ${b.trigger.branch}）`)
    } catch (err) {
      b.buildError = err.message
      log(`触发构建失败：${err.message}`)
    }
  }

  /**
   * 用主 token 查一次仓库连没连上；连上了就接着写构建配置。
   *
   * 没连接时 Cloudflare 回空列表还是 403，没有文档——所以这里拿到 403 不报红，
   * 只在等待提示里带一句「也可能是主 token 缺权限」：用户还没点 Connect 就看到一个红色的
   * 权限错误，正是之前「先建构建 token 再连接」那一版踩的坑。
   */
  async function detectConnection() {
    const tag = await findWorkerTag(state.token, state.accountId, state.workerName)
    let triggers
    try {
      triggers = await listTriggers(state.token, state.accountId, tag, '主 Token（第 ① 步那个）')
    } catch (err) {
      if (err.missingPermission) return { maybeMissingPermission: err.message }
      throw err
    }
    const trigger = pickProductionTrigger(triggers)
    if (!trigger) return {}
    state.builds = { tag, trigger, configured: false, unchanged: false, error: null, buildUuid: null, buildStartedAt: null, build: null, buildError: null }
    log(`检测到仓库已连接 Workers Builds（生产分支 ${trigger.branch}）`)
    await setupTrigger(state.token)
    return {}
  }

  /** 构建进度：拿到终态之前每次轮询都查一次 */
  async function refreshBuild() {
    const b = state.builds
    if (!b?.buildUuid || b.build?.outcome) return
    try {
      b.build = await getBuild(b.apiToken, state.accountId, b.buildUuid)
    } catch (err) {
      log(`查询构建状态失败：${err.message}`)
    }
  }

  /** 轮询一次：还没连上就检测，连上了就刷新构建状态 */
  async function poll() {
    let extra = {}
    if (!state.builds) {
      state.buildsBusy ??= detectConnection().finally(() => {
        state.buildsBusy = null
      })
      try {
        extra = await state.buildsBusy
      } catch (err) {
        extra = { detectError: err.message }
      }
    }
    await refreshBuild()
    return view(extra)
  }

  function view(extra = {}) {
    const b = state.builds
    return {
      connected: !!b,
      configured: !!b?.configured,
      /** 重跑时配置本来就对、上次构建也成功：没改动、没补跑 */
      unchanged: !!b?.unchanged,
      branch: b?.trigger.branch ?? null,
      error: b?.error ?? null,
      buildStarted: !!b?.buildUuid,
      buildStartedAt: b?.buildStartedAt ?? null,
      buildStatus: b?.build?.status ?? null,
      buildOutcome: b?.build?.outcome ?? null,
      buildError: b?.buildError ?? null,
      buildsUrl: state.accountId ? workerBuildsUrl(state.accountId, state.workerName) : null,
      now: Date.now(),
      ...extra,
    }
  }

  /**
   * 验证构建 token 能找到这个 Worker 的生产 trigger——Worker 靠它触发重建。
   * 调用前连接已经确认过，这时再遇到 403 就一定是 token 自己缺权限，可以放心点名。
   */
  async function verifyBuildsToken(buildsToken) {
    let tag
    try {
      tag = await findWorkerTag(buildsToken, state.accountId, state.workerName)
    } catch (err) {
      if (err.status === 403) throw new BootstrapError('构建 Token 缺少「Workers 脚本（读取）」权限——编辑这个 token 补上（token 值不变）')
      throw err
    }
    const triggers = await listTriggers(buildsToken, state.accountId, tag, '构建 Token ')
    if (!pickProductionTrigger(triggers)) throw new BootstrapError('构建 Token 查不到这个 Worker 的构建 trigger——确认 token 的账户范围包含本账户')
  }

  return { setupTrigger, poll, view, verifyBuildsToken }
}
