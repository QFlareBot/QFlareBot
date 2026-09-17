// 产出自包含的 dist/runtime.js，作为投影器可拉取的制品
import { build } from 'esbuild'

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/runtime.js',
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  conditions: ['workerd', 'worker', 'browser'],
  external: ['cloudflare:*'],
  legalComments: 'none',
  sourcemap: 'external',
})
console.log('已生成 dist/runtime.js')
