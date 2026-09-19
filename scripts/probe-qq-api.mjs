#!/usr/bin/env node
/**
 * QQ OpenAPI 探测脚本：调真实接口抓请求/响应的真实形状。
 * 凭证来源（二选一）：
 *   1. --from-kv  从线上 KV 的 rt:bot 读（wrangler 代理，需已 wrangler login）
 *   2. 默认读 apps/seed/.dev.vars
 * 密钥只进内存，不打印。只读探测为主；两个写接口用空体探参数校验（面板若意外创建成功会自动删除）。
 * 用法：node scripts/probe-qq-api.mjs [--from-kv] [groupOpenid]
 */
import { readFileSync } from 'node:fs'

const fromKv = process.argv.includes('--from-kv')
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
let appId
let secret
if (fromKv) {
  const { execSync } = await import('node:child_process')
  const raw = execSync('npx wrangler kv key get rt:bot --binding=KV --remote', {
    cwd: new URL('../apps/seed', import.meta.url),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  ;({ appId, secret } = JSON.parse(raw))
} else {
  const vars = Object.fromEntries(
    readFileSync(new URL('../apps/seed/.dev.vars', import.meta.url), 'utf8')
      .split('\n')
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
  )
  appId = vars.BOT_APPID
  secret = vars.BOT_SECRET
}
if (!appId || !secret) {
  console.error('没有拿到 BOT_APPID / BOT_SECRET')
  process.exit(1)
}

const BASE = 'https://api.bot.qq.com'
const tokenRes = await fetch(`${BASE}/app/getAppAccessToken`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ appId, clientSecret: secret }),
})
const token = (await tokenRes.json()).access_token
if (!token) {
  console.error('换 AccessToken 失败（凭证无效？），HTTP', tokenRes.status)
  process.exit(1)
}

const call = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { authorization: `QQBot ${token}`, 'content-type': 'application/json', 'x-union-appid': appId },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = text.slice(0, 400)
  }
  return { status: res.status, data }
}

const groupOpenid = args[0]
const probes = {
  'GET /users/@me（凭证自检）': () => call('GET', '/users/@me'),
  'GET /v2/panels（当前指令面板）': () => call('GET', '/v2/panels'),
  'GET /v2/groups/join_approval_strategy（审批策略）': () => call('GET', '/v2/groups/join_approval_strategy'),
  'POST /v2/generate_url_link {}（探必填字段）': () => call('POST', '/v2/generate_url_link', {}),
  'POST /v2/panels {}（探必填字段）': async () => {
    const out = await call('POST', '/v2/panels', {})
    // 意外创建成功则回收，不动线上配置
    const id = out.data?.panel_id
    if (out.status < 300 && id) out.cleanup = await call('DELETE', `/v2/panels/${id}`)
    return out
  },
}
if (groupOpenid) {
  probes[`GET /v2/groups/${groupOpenid.slice(0, 6)}…/info（群信息字段）`] = () =>
    call('GET', `/v2/groups/${groupOpenid}/info`)
  probes[`GET /v2/groups/{id}/members（白名单验证）`] = () => call('GET', `/v2/groups/${groupOpenid}/members`)
}

for (const [name, fn] of Object.entries(probes)) {
  const out = await fn().catch((e) => ({ status: -1, data: String(e) }))
  console.log(`\n=== ${name} → HTTP ${out.status}`)
  console.log(JSON.stringify(out.data, null, 2))
  if (out.cleanup) console.log(`（清理：HTTP ${out.cleanup.status}）`)
}
