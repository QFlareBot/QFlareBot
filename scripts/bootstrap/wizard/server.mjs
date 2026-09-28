/**
 * 向导服务：页面文件 + /api。
 *
 * 认领：日志里的向导网址带一次性 sid，第一个带着它打开页面的浏览器拿到专属 Cookie，之后只认
 * 这个 Cookie——别人拿到网址也只能看到「已被接管并锁定」。页面文件本身不含任何账户信息，
 * 谁来都给；锁定页也由它渲染，/api 的 403 带上 gate 告诉页面是缺凭证还是已被接管。
 */

import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { BootstrapError } from '../lib.mjs'
import { json, parseCookies } from './http.mjs'
import { log } from './log.mjs'

// 网址里带着 sid：不让它随 Referer 跟着外链出去
const PAGE_HEADERS = { 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }

function sendFile(res, status, file, extra = {}) {
  res.writeHead(status, {
    'content-type': file.type,
    'cache-control': file.immutable ? 'public, max-age=31536000, immutable' : 'no-store',
    ...PAGE_HEADERS,
    ...extra,
  })
  res.end(file.body)
}

/**
 * session：{ id: 网址里的 sid, cookie: 认领后的 Cookie 值, onClaim() }
 * getUi：返回 loadUi 读好的文件表（构建完成之前为 null）
 */
export function createWizardServer({ session, state, routes, getUi, port }) {
  return createServer(async (req, res) => {
    state.lastActivity = Date.now()
    const url = new URL(req.url, `http://127.0.0.1:${port}`)
    try {
      const authed = !!session.cookie && parseCookies(req).wizard_session === session.cookie

      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' })
        const ui = getUi()
        if (!ui) return json(res, 503, { error: '向导页面还在构建，稍等几秒刷新' })
        if (url.pathname === '/' || url.pathname === '/index.html') {
          const index = ui.get('/index.html')
          if (!session.cookie && url.searchParams.get('sid') === session.id) {
            session.cookie = randomBytes(32).toString('hex')
            session.onClaim()
            return sendFile(res, 200, index, { 'set-cookie': `wizard_session=${session.cookie}; Path=/; HttpOnly; SameSite=Lax` })
          }
          return sendFile(res, authed ? 200 : 403, index)
        }
        const file = ui.get(url.pathname)
        return file ? sendFile(res, 200, file) : json(res, 404, { error: 'not found' })
      }

      // 所有接口一律要求已认领且 Cookie 匹配
      if (!authed) {
        return session.cookie
          ? json(res, 403, { error: '向导已被其他浏览器接管', gate: 'locked' })
          : json(res, 403, { error: '缺少有效的向导凭证（sid）', gate: 'unclaimed' })
      }
      const handler = routes[`${req.method} ${url.pathname}`]
      if (!handler) return json(res, 404, { error: 'not found' })
      await handler(req, res)
    } catch (err) {
      log(`请求失败：${err.message}`)
      json(res, err instanceof BootstrapError ? 400 : 500, { error: err.message, hint: err.hint ?? null })
    }
  })
}
