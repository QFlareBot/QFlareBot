// 把 vite 产物打成运行时可直接返回的资源表模块：dist/ui.js + dist/ui.d.ts
import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve('dist/app')
const TEXT = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.json', 'application/json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json'],
])
const BINARY = new Map([
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'],
  ['.woff', 'font/woff'],
])

async function walk(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full)))
    else out.push(full)
  }
  return out
}

const files = {}
const hash = createHash('sha256')
for (const file of (await walk(root)).sort()) {
  const rel = path.relative(root, file).split(path.sep).join('/')
  const ext = path.extname(rel)
  const buf = await readFile(file)
  hash.update(rel).update(buf)
  if (TEXT.has(ext)) files[rel] = { body: buf.toString('utf8'), type: TEXT.get(ext) }
  else if (BINARY.has(ext)) files[rel] = { body: buf.toString('base64'), type: BINARY.get(ext), encoding: 'base64' }
  else throw new Error(`未知资源类型：${rel}`)
}
const version = hash.digest('hex').slice(0, 16)

await writeFile(
  'dist/ui.js',
  `// 由 @qqbot/ui 构建生成，勿手改\nconst bundle = ${JSON.stringify({ version, index: 'index.html', files })};\nexport default bundle;\n`,
)
await writeFile(
  'dist/ui.d.ts',
  `export interface AssetFile { body: string; type: string; encoding?: 'base64' }\nexport interface AssetBundle { version: string; index: string; files: Record<string, AssetFile> }\ndeclare const bundle: AssetBundle\nexport default bundle\n`,
)
const total = Object.values(files).reduce((n, f) => n + f.body.length, 0)
console.log(`已生成 dist/ui.js：${Object.keys(files).length} 个文件，${(total / 1024).toFixed(1)} KB，version ${version}`)
