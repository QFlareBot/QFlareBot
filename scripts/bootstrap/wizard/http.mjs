/** 向导服务的 HTTP 小工具：Cookie、JSON 请求体与响应 */

export function parseCookies(req) {
  const list = {}
  const rc = req.headers.cookie
  if (rc) {
    for (const cookie of rc.split(';')) {
      const parts = cookie.split('=')
      if (parts.length >= 2) {
        list[parts[0].trim()] = decodeURIComponent(parts.slice(1).join('=').trim())
      }
    }
  }
  return list
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > 1024 * 1024) reject(new Error('请求体过大'))
    })
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

export function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** 请求体里的字符串字段：去掉首尾空白，不是字符串就当没填 */
export function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}
