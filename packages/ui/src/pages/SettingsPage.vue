<script setup lang="ts">
/** 设置：按分区切换，每次只显示一个分区；分区记在地址里（?section=），刷新、分享都停在同一处 */
import { Bot, KeyRound, ListChecks, ShieldCheck, SlidersHorizontal } from 'lucide-vue-next'
import PageHeader from '../components/PageHeader.vue'
import BotSection from '../components/settings/BotSection.vue'
import PermissionSection from '../components/settings/PermissionSection.vue'
import QQMenuCard from '../components/settings/QQMenuCard.vue'
import QQPanelEditor from '../components/settings/QQPanelEditor.vue'
import RuntimeSection from '../components/settings/RuntimeSection.vue'
import SecuritySection from '../components/settings/SecuritySection.vue'
import QSegmented from '../components/ui/QSegmented.vue'
import { useQueryTab } from '../composables/useQueryTab.js'
import { useStatus } from '../composables/useStatus.js'

const { status } = useStatus()
const SECTIONS = [
  { value: 'bot', label: '机器人', icon: Bot },
  { value: 'runtime', label: '运行', icon: SlidersHorizontal },
  { value: 'permission', label: '权限', icon: KeyRound },
  { value: 'commands', label: '指令与菜单', icon: ListChecks },
  { value: 'security', label: '安全', icon: ShieldCheck },
] as const
const section = useQueryTab('section', SECTIONS.map((s) => s.value), 'bot')
</script>

<template>
  <div>
    <PageHeader title="设置" />
    <div class="mb-5"><QSegmented v-model="section" :options="[...SECTIONS]" label="设置分区" /></div>
    <div role="tabpanel" class="max-w-3xl">
      <Transition name="fade" mode="out-in">
        <BotSection v-if="section === 'bot'" />
        <RuntimeSection v-else-if="section === 'runtime'" />
        <PermissionSection v-else-if="section === 'permission'" />
        <div v-else-if="section === 'commands'" class="flex flex-col gap-4">
          <QQPanelEditor :plugins="status?.plugins ?? []" />
          <QQMenuCard />
        </div>
        <SecuritySection v-else />
      </Transition>
    </div>
  </div>
</template>
