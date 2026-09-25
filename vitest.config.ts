import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // Node 里没有 cloudflare:workers（SDK 的 PluginDurableObject 要继承它）。
      // 复用 plugin-cli 抽清单时那个桩，别再造第二份——两份会让「继承基类」的校验
      // 在测试里和真实构建里判出不同结果。
      'cloudflare:workers': fileURLToPath(
        new URL('./packages/plugin-cli/src/stubs/cloudflare-workers.ts', import.meta.url),
      ),
    },
  },
  test: {
    // 自部署脚本是 .mjs，但它那几个判断分支错一个就是静默的生产事故，必须进 CI
    include: ['packages/*/src/**/*.test.ts', 'plugins/*/src/**/*.test.ts', 'apps/*/scripts/**/*.test.mjs'],
    environment: 'node',
  },
})
