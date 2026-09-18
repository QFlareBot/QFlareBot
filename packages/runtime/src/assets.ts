/**
 * 嵌入式静态资源：面板构建产物以"路径 → 内容"表的形式打进 bundle，
 * 由运行时直接返回。同一套函数也供插件的 serveAssets 使用。
 */

export interface AssetFile {
  body: string
  type: string
  /** 二进制文件以 base64 存放 */
  encoding?: 'base64'
}

export interface AssetBundle {
  files: Record<string, AssetFile>
  /** 目录请求与 SPA 回退返回的文件，默认 index.html */
  index?: string
  /** 内容指纹，作为 ETag 与不可变缓存的依据 */
  version?: string
}

const IMMUTABLE = 'public, max-age=31536000, immutable'
const REVALIDATE = 'no-cache'

function decode(file: AssetFile): BodyInit {
  return file.encoding === 'base64' ? Uint8Array.from(atob(file.body), (c) => c.charCodeAt(0)) : file.body
}

/** 带哈希的文件名（Vite 产物）可永久缓存 */
function isFingerprinted(path: string): boolean {
  return /[.-][a-zA-Z0-9_-]{8,}\.[a-z0-9]+$/.test(path)
}

export function serveAsset(bundle: AssetBundle, request: Request, subPath: string): Response | null {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null
  const index = bundle.index ?? 'index.html'
  let path = subPath.replace(/^\/+/, '')
  if (!path || path.endsWith('/')) path += index
  let file = bundle.files[path]
  // SPA 回退：无扩展名的路径回到 index
  if (!file && !path.includes('.')) {
    path = index
    file = bundle.files[index]
  }
  if (!file) return null

  const etag = `"${bundle.version ?? 'dev'}:${path}"`
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304 })

  const headers: Record<string, string> = {
    'content-type': file.type,
    etag,
    'cache-control': isFingerprinted(path) ? IMMUTABLE : REVALIDATE,
    'x-content-type-options': 'nosniff',
    // 插件页面跑在 sandbox iframe（opaque origin）里，模块脚本按跨域加载；面板资源是公开的，放开即可
    'access-control-allow-origin': '*',
  }
  if (path === index) headers['content-security-policy'] = "frame-ancestors 'none'"
  return new Response(request.method === 'HEAD' ? null : decode(file), { headers })
}
