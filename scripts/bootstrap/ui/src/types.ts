/** 向导接口的数据形状，与 scripts/bootstrap/wizard/routes.mjs 一一对应 */

export type StepId = 'token' | 'options' | 'deploy' | 'connect' | 'builds' | 'done'

/** 打不开向导的两种情况：网址缺 sid，或者已被别的浏览器认领 */
export type Gate = 'unclaimed' | 'locked'

export interface Completion {
  triggerConfigured: boolean
  triggerError: string | null
  buildsTokenWritten: boolean
  /** 这次没给、Worker 上本来就有构建 token：沿用（旧服务端没有这个字段） */
  buildsTokenKept?: boolean
  closesAt: number
}

/** 这个名字的 Worker 部署过没有（重跑时第 ② 步据此提示、让用户选择沿用原密码） */
export type ExistingInfo =
  | { workerName: string; exists: false }
  | {
      workerName: string
      exists: true
      hasAdminToken: boolean
      hasBuildsToken: boolean
      /** 面板里装了几个插件；查不到为 null */
      pluginCount: number | null
      /** 仓库连没连过；查不到为 null */
      connected: boolean | null
    }

export interface Resume {
  step: StepId
  accountId: string | null
  accountName: string | null
  workerName: string
  completion: Completion | null
}

export interface InitData {
  repo: string
  defaults: { workerName: string; kvName: string; d1Name: string; r2Name: string }
  setupTokenUrl: string
  buildCommand: string
  deployCommand: string
  adminTokenMinLength: number
  resume: Resume
  closesAt: number | null
  now: number
}

export interface Account {
  id: string
  name: string
}

export interface VerifyResult {
  ok: true
  accountId: string
  accountName: string | null
}

export type StepState = 'run' | 'ok' | 'warn' | 'fail'

export interface ProgressStep {
  name: string
  state: StepState
  detail: string | null
  startedAt: number
  endedAt: number | null
}

export interface ResourceView {
  name: string
  created: boolean
}

export interface DeployResult {
  accountId: string
  workerName: string
  panelUrl: string
  manifestUrl: string
  buildsTokenUrl: string
  buildsConnectUrl: string
  domainsUrl: string
  buildsUrl: string
  resources: { kv: ResourceView | null; d1: ResourceView | null; r2: ResourceView | null }
  warnings: string[]
  /** 部署之前 Worker 就在：这是一次重跑 */
  redeployed?: boolean
  adminTokenKept?: boolean
  /** Worker 上本来就有构建 token */
  buildsTokenExisting?: boolean
}

export interface Progress {
  started: boolean
  steps: ProgressStep[]
  log: string[]
  done: boolean
  ok: boolean
  error?: string | null
  hint?: string | null
  result?: DeployResult | null
  now: number
}

export interface Connection {
  connected: boolean
  configured: boolean
  /** 重跑时配置本来就对、上次构建也成功：没改动、没补跑 */
  unchanged?: boolean
  branch: string | null
  error: string | null
  buildStarted: boolean
  buildStartedAt: number | null
  buildStatus: string | null
  buildOutcome: string | null
  buildError: string | null
  buildsUrl: string | null
  now: number
  detectError?: string
  maybeMissingPermission?: string
}

/** 第 ② 步的面板密码：沿用 Worker 上已有的，还是设一个新的 */
export type PasswordMode = 'keep' | 'new'

/** adminToken 与 keepAdminToken 二选一：沿用原密码时不发密码 */
export type ProvisionOptions = { workerName: string; r2Name: string } & ({ adminToken: string } | { keepAdminToken: true })
