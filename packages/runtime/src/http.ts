export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })
}

export function error(message: string, status: number): Response {
  return json({ ok: false, error: message }, status)
}

export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T
  } catch {
    return null
  }
}

/** `/p/foo/items/:id` 这类模式匹配，返回参数表 */
export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean)
  const s = pathname.split('/').filter(Boolean)
  if (p.length !== s.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < p.length; i++) {
    const seg = p[i]!
    const actual = s[i]!
    if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(actual)
    else if (seg !== actual) return null
  }
  return params
}
