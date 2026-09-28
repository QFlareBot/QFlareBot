<script setup lang="ts">
/** 向导之外还要做的三件事：绑域名 → 建机器人 → 填回调地址 */
import type { DeployResult } from '../../types.js'
import LinkButton from '../base/LinkButton.vue'
import StepCard from '../base/StepCard.vue'
import SubStep from '../base/SubStep.vue'

defineProps<{ result: DeployResult }>()
</script>

<template>
  <StepCard
    title="接下来"
    :description="
      result.redeployed
        ? '之前绑的域名、建的机器人都还在，做过的不用重做；还没做完的照下面来。'
        : '这三步在 Cloudflare 和 QQ 开放平台的后台做，做完机器人就能收发消息了。'
    "
  >
    <SubStep :n="1" title="绑定自定义域名（必需）">
      <p class="text-xs text-pretty text-fg-muted">
        QQ 开放平台访问不到 <code class="font-mono">*.workers.dev</code>，回调必须走你自己的域名。在 Custom Domains 里添加一个托管在这个账户下的域名，比如
        <code class="font-mono">bot.yourdomain.com</code>。之后的部署都不会改动它。
      </p>
      <LinkButton class="mt-3" :href="result.domainsUrl">打开域名设置</LinkButton>
    </SubStep>
    <SubStep :n="2" title="创建 QQ 机器人">
      <p class="text-xs text-pretty text-fg-muted">用新域名打开面板，到「设置」里用手机 QQ 扫码创建，或填入已有机器人的 AppID / AppSecret。</p>
    </SubStep>
    <SubStep :n="3" title="填回调地址" last>
      <p class="text-xs text-pretty text-fg-muted">
        在 QQ 开放平台把回调地址填成 <code class="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-fg">https://你的域名/webhook</code>，面板概览页可以一键复制。
      </p>
    </SubStep>
  </StepCard>
</template>
