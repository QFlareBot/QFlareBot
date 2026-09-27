<script setup lang="ts">
/**
 * 两个性质相反的工具分开放：
 * 模拟事件是**干跑**，走 /admin/test-event，不碰 QQ；真实发送走 /admin/send，对方会真的收到。
 * 两个面板都挂着（v-show），切标签不丢对话记录。
 */
import { FlaskConical, Send } from 'lucide-vue-next'
import PageHeader from '../components/PageHeader.vue'
import SendPanel from '../components/debug/SendPanel.vue'
import SimulatorPanel from '../components/debug/SimulatorPanel.vue'
import QSegmented from '../components/ui/QSegmented.vue'
import { useQueryTab } from '../composables/useQueryTab.js'

const tab = useQueryTab('tab', ['simulate', 'send'] as const, 'simulate')
const TABS = [
  { value: 'simulate', label: '模拟事件', icon: FlaskConical },
  { value: 'send', label: '真实发送', icon: Send },
]
</script>

<template>
  <div>
    <PageHeader title="调试" description="模拟事件是干跑，不会发到 QQ；真实发送会真的发出去。" />
    <div class="mb-4"><QSegmented v-model="tab" :options="TABS" label="调试工具" /></div>
    <div v-show="tab === 'simulate'" role="tabpanel"><SimulatorPanel /></div>
    <div v-show="tab === 'send'" role="tabpanel"><SendPanel /></div>
  </div>
</template>
