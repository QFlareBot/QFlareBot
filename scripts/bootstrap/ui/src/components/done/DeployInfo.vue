<script setup lang="ts">
/** 部署信息：资源是新建还是复用、构建机拉清单的地址；默认收起 */
import QBadge from '@panel/components/ui/QBadge.vue'
import QCollapse from '@panel/components/ui/QCollapse.vue'
import { ChevronDown } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import type { DeployResult } from '../../types.js'
import CopyField from '../base/CopyField.vue'
import StepCard from '../base/StepCard.vue'

const props = defineProps<{ result: DeployResult }>()
const open = ref(false)
const rows = computed(() => {
  const { kv, d1, r2 } = props.result.resources
  return [
    { label: 'Worker', name: props.result.workerName, badge: null },
    { label: 'KV', name: kv?.name ?? null, badge: kv ? (kv.created ? '新建' : '复用') : null },
    { label: 'D1', name: d1?.name ?? null, badge: d1 ? (d1.created ? '新建' : '复用') : null },
    { label: 'R2', name: r2?.name ?? null, badge: r2 ? (r2.created ? '新建' : '复用') : null },
  ]
})
</script>

<template>
  <StepCard>
    <button type="button" class="flex w-full cursor-pointer items-center justify-between gap-3 text-left" :aria-expanded="open" @click="open = !open">
      <span class="min-w-0">
        <span class="block text-sm font-semibold text-fg">部署信息</span>
        <span class="mt-0.5 block text-xs text-fg-muted">用了哪些资源，构建机从哪里拉插件清单。</span>
      </span>
      <ChevronDown class="size-4 shrink-0 text-fg-muted transition-transform duration-(--qb-duration-slow)" :class="open && 'rotate-180'" aria-hidden="true" />
    </button>
    <QCollapse :open="open">
      <dl class="mt-4 divide-y divide-border rounded-md border border-border">
        <div v-for="r in rows" :key="r.label" class="flex items-center gap-3 px-3 py-2.5 text-sm">
          <dt class="w-16 shrink-0 text-xs text-fg-muted">{{ r.label }}</dt>
          <dd class="min-w-0 flex-1 truncate font-mono text-xs" :class="r.name ? 'text-fg' : 'text-fg-subtle'">{{ r.name ?? '不启用' }}</dd>
          <QBadge v-if="r.badge" :tone="r.badge === '新建' ? 'accent' : 'neutral'">{{ r.badge }}</QBadge>
        </div>
      </dl>
      <CopyField class="mt-4" label="构建机拉清单的地址（MANIFEST_URL）" :value="result.manifestUrl" />
    </QCollapse>
  </StepCard>
</template>
