/**
 * 公开日志里的打码。公开仓库的 Actions 日志与 Step Summary 谁都能看：账户 ID、workers.dev 子域、
 * 资源 id 一拿到就打码（maskInLog）；事先不知道的（报错里的 trigger / build uuid、部署打印的
 * Version ID）按形状过滤（redactApiPath / redactIds）。
 */

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
/** 账户 ID、KV id、Worker tag 都是 32 位十六进制 */
const HEX32 = '[0-9a-f]{32}'
const ID_SEGMENT = new RegExp(`^(?:${UUID}|${HEX32})$`, 'i')
const ID_IN_TEXT = new RegExp(`\\b(?:${UUID}|${HEX32})\\b`, 'gi')

/**
 * 进公开日志之前的 API 路径：账户那一段，以及所有 uuid / 32 位十六进制形状的段
 * （trigger、build 的 uuid，Worker tag，D1 id……）都换成 `…`。查询串原样保留。
 * 报错时路径里是什么就带出什么，只遮账户的话，trigger / build 的 uuid 照样进了谁都能看的日志。
 */
export function redactApiPath(apiPath) {
  const q = apiPath.indexOf('?')
  const pathname = q === -1 ? apiPath : apiPath.slice(0, q)
  const redacted = pathname
    .replace(/\/accounts\/[^/]+/, '/accounts/…')
    .split('/')
    .map((segment) => (ID_SEGMENT.test(segment) ? '…' : segment))
    .join('/')
  return q === -1 ? redacted : redacted + apiPath.slice(q)
}

/** 旧名字，行为同 redactApiPath */
export const redactAccountPath = redactApiPath

/**
 * 一段要进公开日志的文字：里面 uuid / 32 位十六进制形状的标识都换成 `***`（与 add-mask 的样子一致）。
 * 用在事先不知道值、没法 add-mask 的地方：Cloudflare 报错信息里夹带的 id、wrangler deploy 打印的 Version ID。
 * 40 位的 commit sha、64 位的哈希不受影响（前后都是十六进制字符，不满足单词边界）。
 */
export function redactIds(text) {
  return String(text).replace(ID_IN_TEXT, '***')
}

/**
 * 让 GitHub Actions 在之后的日志里把这个值替换成 `***`。
 * 兜住子进程的输出：wrangler 部署时会打印 workers.dev 地址和 KV / D1 的 id，这些都进公开日志。
 * 只对事先知道的值有用；部署时才生成的 Version ID 由 buildAndDeploy 过滤输出时遮掉（redactIds）。
 * 只对日志生效，Step Summary 不打码——Summary 靠 renderSummary 的 publicView 不写这些值。
 */
export function maskInLog(value) {
  if (value && process.env.GITHUB_ACTIONS === 'true') console.log(`::add-mask::${value}`)
}
