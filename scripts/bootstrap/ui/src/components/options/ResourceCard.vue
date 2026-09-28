<script setup lang="ts">
/** 资源名称：默认收起，只显示将要用的名字；展开可以改 Worker 名与 R2 桶名 */
import QButton from '@panel/components/ui/QButton.vue'
import QCollapse from '@panel/components/ui/QCollapse.vue'
import QField from '@panel/components/ui/QField.vue'
import QInput from '@panel/components/ui/QInput.vue'
import { ChevronDown } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import { resourcePlan } from '../../lib/names.js'
import type { InitData } from '../../types.js'
import StepCard from '../base/StepCard.vue'

const props = defineProps<{ defaults: InitData['defaults']; locked: boolean }>()
const worker = defineModel<string>('worker', { required: true })
const r2 = defineModel<string>('r2', { required: true })
const advanced = ref(false)

const plan = computed(() =>
  resourcePlan({
    workerName: worker.value,
    defaultWorkerName: props.defaults.workerName,
    kvName: props.defaults.kvName,
    d1Name: props.defaults.d1Name,
    r2Name: r2.value,
  }),
)
</script>

<template>
  <StepCard>
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <h2 class="text-sm font-semibold text-fg">资源名称</h2>
        <p class="mt-0.5 text-xs text-fg-muted">账户里已有同名的会直接复用，重跑引导不会重复创建。</p>
      </div>
      <QButton v-if="!locked" size="sm" variant="ghost" :aria-expanded="advanced" @click="advanced = !advanced">
        {{ advanced ? '收起' : '修改' }}
        <ChevronDown class="size-3.5 transition-transform duration-(--qb-duration-slow)" :class="advanced && 'rotate-180'" aria-hidden="true" />
      </QButton>
    </div>
    <ul class="mt-3.5 flex flex-wrap gap-1.5">
      <li v-for="r in plan" :key="r.label" class="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-muted/60 py-1 pr-2.5 pl-2 text-xs">
        <span class="text-fg-subtle">{{ r.label }}</span>
        <span class="font-mono" :class="r.name ? 'text-fg' : 'text-fg-subtle'">{{ r.name ?? '不启用' }}</span>
      </li>
    </ul>
    <QCollapse :open="advanced && !locked">
      <div class="grid gap-4 pt-5 sm:grid-cols-2">
        <QField id="f-worker" label="Worker 名称" hint="KV、D1 默认也用这个名字">
          <template #default="{ describedBy }">
            <QInput id="f-worker" v-model="worker" mono :placeholder="defaults.workerName" :described-by="describedBy" />
          </template>
        </QField>
        <QField id="f-r2" label="R2 桶名" hint="留空用默认；填 none 不启用">
          <template #default="{ describedBy }">
            <QInput id="f-r2" v-model="r2" mono :placeholder="`${worker.trim() || defaults.workerName}-artifacts`" :described-by="describedBy" />
          </template>
        </QField>
      </div>
    </QCollapse>
  </StepCard>
</template>
