import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 自部署脚本是 .mjs，但它那几个判断分支错一个就是静默的生产事故，必须进 CI
    include: ['packages/*/src/**/*.test.ts', 'plugins/*/src/**/*.test.ts', 'apps/*/scripts/**/*.test.mjs'],
    environment: 'node',
  },
})
