import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // Node 里没有 cloudflare:workers（SDK 的 PluginDurableObject 要继承它），
      // 用 plugin-cli 抽清单时的同一个桩，测试与真实构建判出的结果才一致
      'cloudflare:workers': fileURLToPath(
        new URL('./node_modules/@qqbot/plugin-cli/dist/stubs/cloudflare-workers.js', import.meta.url),
      ),
    },
  },
})
