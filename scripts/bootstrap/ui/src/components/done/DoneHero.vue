<script setup lang="ts">
/** 完成页的头：大对勾弹出来扩一圈光，主按钮直达面板 */
import { Check } from 'lucide-vue-next'
import type { DeployResult } from '../../types.js'
import CopyField from '../base/CopyField.vue'
import LinkButton from '../base/LinkButton.vue'

defineProps<{ result: DeployResult }>()
</script>

<template>
  <section class="relative overflow-hidden rounded-xl border border-card-border bg-surface p-6 shadow-card md:p-8">
    <div
      class="pointer-events-none absolute inset-0 bg-[radial-gradient(560px_240px_at_0%_0%,color-mix(in_srgb,var(--qb-accent)_16%,transparent),transparent_70%),radial-gradient(420px_220px_at_100%_100%,color-mix(in_srgb,var(--qb-brand)_8%,transparent),transparent_70%)]"
      aria-hidden="true"
    />
    <div class="relative">
      <span class="qb-celebrate flex size-14 items-center justify-center rounded-full bg-accent text-on-accent shadow-[0_8px_24px_-8px_var(--qb-accent)]" aria-hidden="true">
        <Check class="size-7" :stroke-width="3" />
      </span>
      <h1 data-step-title tabindex="-1" class="mt-5 text-2xl font-semibold tracking-tight text-balance text-fg outline-none">
        {{ result.redeployed ? '重新部署完成' : '部署完成' }}
      </h1>
      <p class="mt-1 max-w-lg text-sm text-pretty text-fg-muted">
        {{
          result.redeployed
            ? '新版本已经上线，资源、数据、插件、域名和机器人配置都没动。'
            : 'Worker 已经上线。离机器人收发消息还差绑定域名、创建机器人两步，照下面做就行。'
        }}
      </p>
      <div class="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2">
        <LinkButton :href="result.panelUrl" variant="primary" size="lg">打开管理面板</LinkButton>
        <span class="text-xs text-fg-muted">{{ result.adminTokenKept ? '密码没变，已经登录的照常可用' : '用第 2 步设置的密码登录' }}</span>
      </div>
      <CopyField class="mt-5 max-w-lg" label="面板地址（可以先用它登录看看，但别当成回调地址）" :value="result.panelUrl" />
    </div>
  </section>
</template>
