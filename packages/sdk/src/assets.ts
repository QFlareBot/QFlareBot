import type { Route, RouteInput } from './plugin.js'

/** 内联静态资源：`qqbot-plugin build` 会把 `ui/` 目录的构建产物生成为这张表 */
export interface AssetFile {
  body: string
  type: string
  encoding?: 'base64'
}

export interface AssetMap {
  files: Record<string, AssetFile>
  index?: string
  version?: string
}

function decode(file: AssetFile): Uint8Array | string {
  return file.encoding === 'base64' ? Uint8Array.from(atob(file.body), (c) => c.charCodeAt(0)) : file.body
}

/**
 * 生成一条服务静态资源的路由：`serveAssets('/ui/*', assets)`。
 * 默认要求面板登录态（`auth: 'admin'`），公开页面传 `{ auth: 'public' }`。
 */
export function serveAssets<C = unknown>(
  path: `${string}/*`,
  assets: AssetMap,
  options: { auth?: 'public' | 'admin' } = {},
): Route<C> {
  const index = assets.index ?? 'index.html'
  return {
    method: 'GET',
    path,
    auth: options.auth ?? 'admin',
    handler({ request, params }: RouteInput<C>) {
      let rel = params['*'] ?? ''
      if (!rel || rel.endsWith('/')) rel += index
      let file = assets.files[rel]
      if (!file && !rel.includes('.')) file = assets.files[(rel = index)]
      if (!file) return new Response('Not Found', { status: 404 })

      const etag = `"${assets.version ?? 'dev'}:${rel}"`
      if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304 })
      const fingerprinted = /[.-][a-zA-Z0-9_-]{8,}\.[a-z0-9]+$/.test(rel)
      return new Response(decode(file), {
        headers: {
          'content-type': file.type,
          etag,
          'cache-control': fingerprinted ? 'public, max-age=31536000, immutable' : 'no-cache',
          'x-content-type-options': 'nosniff',
        },
      })
    },
  }
}
