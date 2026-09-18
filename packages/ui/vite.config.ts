import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  build: {
    outDir: 'dist/app',
    emptyOutDir: true,
    // 面板与 Worker 制品一起分发，产物尽量少文件
    assetsInlineLimit: 8192,
    rollupOptions: {
      // bridge 客户端不带哈希，供插件页面以固定地址引用；保留它的命名导出
      input: { main: 'index.html', bridge: 'src/bridge-client.ts' },
      preserveEntrySignatures: 'exports-only',
      output: {
        entryFileNames: (chunk) => (chunk.name === 'bridge' ? 'bridge.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/admin': 'http://127.0.0.1:8787',
      '/p': 'http://127.0.0.1:8787',
      '/healthz': 'http://127.0.0.1:8787',
    },
  },
})
