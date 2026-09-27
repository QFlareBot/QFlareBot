<script setup lang="ts">
/**
 * 两个性质相反的工具分开放：
 * 模拟事件是**干跑**，走 /admin/test-event，不碰 QQ；真实发送走 /admin/send，对方会真的收到。
 * 切走的面板由 KeepAlive 留着，切回来对话记录还在；切换过渡与设置、添加插件同一套（tab）。
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
    <div role="tabpanel">
      <Transition name="tab" mode="out-in">
        <KeepAlive>
          <SimulatorPanel v-if="tab === 'simulate'" />
          <SendPanel v-else />
        </KeepAlive>
      </Transition>
    </div>
  </div>
</template>
