import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import { mockApi } from './dev/mockApi.js'

/**
 * 向导页面。组件、token 与动效直接用面板的源码（`@panel/*` → packages/ui/src），两边长得一样、改一处就够。
 * `pnpm dev` 自带模拟接口（dev/mockApi.ts），不用真的 Cloudflare 账户就能把每一步走一遍。
 */
export default defineConfig(({ command }) => ({
  plugins: [vue(), tailwindcss(), command === 'serve' && mockApi()],
  resolve: {
    alias: { '@panel': fileURLToPath(new URL('../../../packages/ui/src', import.meta.url)) },
    // 面板源码里的 import 'vue' 从 packages/ui 解析，保证只打进一份
    dedupe: ['vue'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 8192,
  },
  server: { port: 5174 },
}))
