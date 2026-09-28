<script setup lang="ts">
/**
 * 在 Cloudflare 里连接仓库的三步。到这一步时仓库已经连着（重跑）就收起来，
 * 只留一行可以展开的「连接方法」；检测到连接时正在看的，照旧展开着，对勾逐项亮起。
 */
import QCollapse from '@panel/components/ui/QCollapse.vue'
import { ChevronDown } from 'lucide-vue-next'
import { ref } from 'vue'
import CopyField from '../base/CopyField.vue'
import LinkButton from '../base/LinkButton.vue'
import StepCard from '../base/StepCard.vue'
import SubStep from '../base/SubStep.vue'

const props = defineProps<{ connectUrl?: string; repo: string; buildCommand: string; deployCommand: string; connected: boolean; folded: boolean }>()
const open = ref(!props.folded)
const opened = ref(false)
</script>

<template>
  <StepCard>
    <button v-if="folded" type="button" class="flex w-full cursor-pointer items-center justify-between gap-3 text-left" :aria-expanded="open" @click="open = !open">
      <span class="min-w-0">
        <span class="block text-sm font-semibold text-fg">连接方法</span>
        <span class="mt-0.5 block text-xs text-fg-muted">仓库已经连好了，不用再做；想重新连接时照这里来。</span>
      </span>
      <ChevronDown class="size-4 shrink-0 text-fg-muted transition-transform duration-(--qb-duration-slow)" :class="open && 'rotate-180'" aria-hidden="true" />
    </button>
    <h2 v-else class="text-sm font-semibold text-fg">在 Cloudflare 里操作</h2>
    <QCollapse :open="open">
      <div class="pt-4">
        <SubStep :n="1" title="打开 Worker 设置页" :done="opened || connected">
          <LinkButton v-if="connectUrl" :href="connectUrl" :variant="opened || connected ? 'secondary' : 'primary'" @click="opened = true">打开设置页</LinkButton>
        </SubStep>
        <SubStep :n="2" title="在 Build 一栏点 Connect" :done="connected">
          <p class="text-xs text-pretty text-fg-muted">
            选择仓库 <code class="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-fg">{{ repo }}</code>，分支选默认分支。
          </p>
        </SubStep>
        <SubStep :n="3" title="照下面填两条命令，其余保持默认" :done="connected" last>
          <div class="grid gap-3">
            <CopyField label="Build command" :value="buildCommand" />
            <CopyField label="Deploy command" :value="deployCommand" />
          </div>
          <p class="mt-2.5 text-xs text-pretty text-fg-subtle">表单默认的 npx wrangler deploy 在这个仓库里跑不通。填错了也不要紧，检测到连接后向导会自动改正。</p>
        </SubStep>
      </div>
    </QCollapse>
  </StepCard>
</template>
