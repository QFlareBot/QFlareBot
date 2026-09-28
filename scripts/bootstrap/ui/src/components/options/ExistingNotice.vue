<script setup lang="ts">
/** 重跑时的说明：这个 Worker 已经部署过，这次会做什么、哪些东西不动 */
import { Check, History } from 'lucide-vue-next'
import { computed } from 'vue'
import type { ExistingInfo } from '../../types.js'

const props = defineProps<{ info: Extract<ExistingInfo, { exists: true }> }>()

const items = computed(() => {
  const { pluginCount, connected, hasBuildsToken } = props.info
  return [
    '复用已有的 KV、D1、R2，里面的数据不动',
    pluginCount === 0 ? null : `面板里装的${pluginCount ? ` ${pluginCount} 个` : ''}插件按原来的版本一起重新构建`,
    '新版本先在预览地址做健康检查，通过了才切流量；不通过的话线上保持原样',
    '自定义域名、QQ 机器人和插件配置都不动',
    connected ? '仓库已经连好，第 4 步会自动确认，配置没变就不再补跑构建' : null,
    hasBuildsToken ? '构建 Token 已经有了，第 5 步可以直接沿用' : null,
  ].filter((s): s is string => !!s)
})
</script>

<template>
  <section class="rounded-lg border border-accent/25 bg-primary/40 p-5 md:p-6">
    <div class="flex items-start gap-3.5">
      <span class="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface text-accent shadow-card" aria-hidden="true">
        <History class="size-4.5" />
      </span>
      <div class="min-w-0 flex-1">
        <p class="text-sm font-semibold text-balance text-fg">
          <code class="font-mono">{{ info.workerName }}</code> 已经部署过，这次是重新部署
        </p>
        <ul class="mt-2.5 space-y-1.5">
          <li v-for="item in items" :key="item" class="flex items-start gap-2 text-xs text-pretty text-fg-muted">
            <Check class="mt-0.5 size-3.5 shrink-0 text-accent" :stroke-width="2.6" aria-hidden="true" />{{ item }}
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>
