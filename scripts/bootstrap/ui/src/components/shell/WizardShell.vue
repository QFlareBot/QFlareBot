<script setup lang="ts">
/**
 * 布局：桌面左侧是浮在底色上的半透明步骤栏，右侧一次只放一步；手机是顶栏 + 分段进度。
 * 页面跟着文档滚动，手机浏览器的地址栏才能随滚动收起；底部不放任何固定元素。
 */
import { computed, type Component } from 'vue'
import BuildsTokenStep from '../../steps/BuildsTokenStep.vue'
import ConnectStep from '../../steps/ConnectStep.vue'
import DeployStep from '../../steps/DeployStep.vue'
import DoneStep from '../../steps/DoneStep.vue'
import OptionsStep from '../../steps/OptionsStep.vue'
import TokenStep from '../../steps/TokenStep.vue'
import type { StepId } from '../../types.js'
import { useWizard } from '../../wizard.js'
import BuildChip from './BuildChip.vue'
import MobileHeader from './MobileHeader.vue'
import StepRail from './StepRail.vue'

const VIEWS: Record<StepId, Component> = {
  token: TokenStep,
  options: OptionsStep,
  deploy: DeployStep,
  connect: ConnectStep,
  builds: BuildsTokenStep,
  done: DoneStep,
}

const w = useWizard()
const view = computed(() => VIEWS[w.current.value])

/** 切过去之后，读屏与键盘从新步骤的标题开始 */
function focusTitle() {
  document.querySelector<HTMLElement>('[data-step-title]')?.focus({ preventScroll: true })
}
</script>

<template>
  <MobileHeader />
  <div class="mx-auto flex w-full max-w-[1120px] md:gap-8 md:px-6">
    <aside class="sticky top-0 hidden h-dvh w-[272px] shrink-0 py-6 md:block">
      <div class="qb-glass h-full overflow-hidden rounded-[20px] shadow-card"><StepRail /></div>
    </aside>

    <main
      class="min-w-0 flex-1 pt-5 pr-[max(1rem,env(safe-area-inset-right))] pb-[calc(env(safe-area-inset-bottom)+3rem)] pl-[max(1rem,env(safe-area-inset-left))] md:px-0 md:pt-14"
    >
      <div class="mx-auto max-w-[680px]">
        <!-- 手机上没有步骤栏，补跑构建的状态放到内容顶上（连接页自己有完整的状态） -->
        <div v-if="w.current.value !== 'connect'" class="mb-4 empty:hidden md:hidden"><BuildChip /></div>
        <!-- 子元素错落上浮的动画比根元素长，给足总时长，免得类名被提前摘掉 -->
        <Transition :name="`step-${w.direction.value}`" mode="out-in" :duration="{ enter: 720, leave: 160 }" @after-enter="focusTitle">
          <component :is="view" :key="w.current.value" />
        </Transition>
      </div>
    </main>
  </div>
</template>
