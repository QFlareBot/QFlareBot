/**
 * 向导的状态与动作，所有步骤共用一份。服务端才是准：页面刷新后按 /api/init 的 resume 接着走，
 * 部署进度、仓库连接各有一个轮询，一直跑到有结果为止（切到别的步骤也不停，步骤栏要显示）。
 */
import { computed, ref, shallowRef } from 'vue'
import { api, ApiError, setGateHandler } from './api.js'
import { syncServerClock } from './lib/clock.js'
import { createPoller } from './lib/poller.js'
import { stepIndex } from './lib/steps.js'
import type { Completion, Connection, Gate, InitData, Progress, ProvisionOptions, StepId } from './types.js'

export type Ended = 'closed' | 'cancelled' | 'offline' | Gate

const init = shallowRef<InitData | null>(null)
const current = ref<StepId>('token')
const reached = ref<StepId>('token')
const direction = ref<'forward' | 'back'>('forward')
const account = shallowRef<{ id: string; name: string | null } | null>(null)
const workerName = ref('qqbot')
const progress = shallowRef<Progress | null>(null)
const connection = shallowRef<Connection | null>(null)
const completion = shallowRef<Completion | null>(null)
const ended = ref<Ended | null>(null)
const loadError = ref<string | null>(null)
/** 这次是重跑（第 ② 步查到 Worker 已经在）：部署页据此换说法；刷新后不知道就按首次说 */
const redeploy = ref(false)

/** 上次提交的部署选项（含管理密码，只在内存里）：失败后「重试」原样再发；刷新后没了就回第 ② 步重填 */
let lastOptions: ProvisionOptions | null = null

const emptyProgress = (): Progress => ({ started: true, steps: [], log: [], done: false, ok: false, now: Date.now() })

function end(kind: Ended) {
  ended.value = kind
  progressPoller.stop()
  connectionPoller.stop()
}
setGateHandler(end)

const progressPoller = createPoller(
  async () => {
    const p = await api.progress()
    syncServerClock(p.now)
    progress.value = p
    // 重跑时仓库多半早就连好了：部署一完就去确认，到第 ④ 步时结果已经在了
    if (p.done && p.ok && p.result?.redeployed && !completion.value) connectionPoller.start()
    return !p.done
  },
  { interval: 1200, onOffline: () => end('offline') },
)

/** 没连上时每 3 秒检测一次；连上后盯着补跑的那次构建，出结果就停 */
const connectionPoller = createPoller(
  async () => {
    const c = await api.connection()
    syncServerClock(c.now)
    connection.value = c
    if (!c.connected) return true
    return c.buildStarted && !c.buildOutcome
  },
  { interval: () => (connection.value?.connected ? 5000 : 3000), onOffline: () => end('offline') },
)

function moveTo(step: StepId) {
  if (step === current.value) return
  direction.value = stepIndex(step) > stepIndex(current.value) ? 'forward' : 'back'
  current.value = step
  if (stepIndex(step) > stepIndex(reached.value)) reached.value = step
  if (step === 'connect' && !completion.value) connectionPoller.start()
  window.scrollTo({ top: 0 })
}

async function load() {
  loadError.value = null
  try {
    const data = await api.init()
    syncServerClock(data.now)
    const r = data.resume
    workerName.value = r.workerName
    account.value = r.accountId ? { id: r.accountId, name: r.accountName } : null
    completion.value = r.completion
    if (stepIndex(r.step) >= stepIndex('deploy')) {
      progress.value = await api.progress()
      if (!progress.value.done) progressPoller.start()
    }
    current.value = reached.value = r.step
    if (stepIndex(r.step) >= stepIndex('connect')) connectionPoller.start()
    init.value = data
  } catch (err) {
    if (ended.value) return
    if (err instanceof ApiError && err.offline) end('offline')
    else loadError.value = (err as Error).message
  }
}

/** 服务端已经不在了（超时退出、runner 被取消）也算关掉了 */
async function leaveWith(call: () => Promise<unknown>) {
  try {
    await call()
  } catch (err) {
    if (!(err instanceof ApiError && err.offline)) throw err
  }
}

/** 部署开始后（失败了除外）Token 和设置都不能再改 */
const deployLocked = computed(() => {
  const p = progress.value
  return !!p?.started && !(p.done && !p.ok)
})

export function useWizard() {
  return {
    init,
    current,
    reached,
    direction,
    account,
    workerName,
    progress,
    connection,
    completion,
    ended,
    loadError,
    deployLocked,
    load,
    moveTo,
    /** 步骤栏上点回去看：只能去已经走到过的步骤，完成之后不再回头 */
    goto(step: StepId) {
      if (completion.value || stepIndex(step) > stepIndex(reached.value)) return
      moveTo(step)
    },
    async verify(token: string, accountId?: string) {
      account.value = null
      const res = await api.verify(token, accountId)
      account.value = { id: res.accountId, name: res.accountName }
      return res
    },
    redeploy,
    async provision(options: ProvisionOptions, isRedeploy = false) {
      await api.provision(options)
      lastOptions = options
      redeploy.value = isRedeploy
      workerName.value = options.workerName.trim() || init.value?.defaults.workerName || workerName.value
      progress.value = emptyProgress()
      moveTo('deploy')
      progressPoller.start()
    },
    canRetry: () => lastOptions !== null,
    async retry() {
      if (!lastOptions) return moveTo('options')
      await api.provision(lastOptions)
      progress.value = emptyProgress()
      progressPoller.start()
    },
    verifyBuildsToken: (token: string) => api.buildsToken(token),
    async complete(buildsToken?: string) {
      const c = await api.complete(buildsToken)
      syncServerClock(c.now)
      completion.value = c
      // 主 token 没写成配置时，构建 token 会再试一次、补跑构建：接着盯
      if (connection.value?.connected) connectionPoller.start()
      else connectionPoller.stop()
      moveTo('done')
    },
    async exitWizard() {
      await leaveWith(api.exit)
      end('closed')
    },
    async cancelWizard() {
      await leaveWith(api.cancel)
      end('cancelled')
    },
  }
}
