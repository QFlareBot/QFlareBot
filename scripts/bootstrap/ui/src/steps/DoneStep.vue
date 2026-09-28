<script setup lang="ts">
/** 完成：面板入口、构建链路的结论、接下来的三件事、部署信息、倒计时 */
import { computed } from 'vue'
import Callout from '../components/base/Callout.vue'
import CloseCard from '../components/done/CloseCard.vue'
import DeployInfo from '../components/done/DeployInfo.vue'
import DoneHero from '../components/done/DoneHero.vue'
import NextSteps from '../components/done/NextSteps.vue'
import { useWizard } from '../wizard.js'

const w = useWizard()
const result = computed(() => w.progress.value?.result ?? null)
const c = computed(() => w.completion.value)
</script>

<template>
  <div v-if="result && c" class="flex flex-col gap-4">
    <DoneHero :result="result" />

    <div class="space-y-2">
      <Callout v-if="c.triggerConfigured && w.connection.value?.unchanged" tone="success" title="构建配置和上次一致">
        构建设置本来就是对的，上次的构建也成功了，这次没有改动。
      </Callout>
      <Callout v-else-if="c.triggerConfigured" tone="success" title="构建配置已自动写入">
        构建命令、部署命令、排除路径、构建缓存和清单地址都写进了 Worker 的构建设置，到面板装一个插件就能验证重建链路。
      </Callout>
      <Callout v-else tone="warning" title="构建配置没有自动写入">
        {{ c.triggerError ?? '仓库还没连接' }}。在补齐之前，装插件不会触发重建：连上仓库、配好构建 Token 后，Worker 第一次从面板触发构建时会自动补写；想手动填，照 run 页 Summary 里的清单来。
      </Callout>
      <Callout v-if="c.buildsTokenKept" tone="success" title="沿用了 Worker 上已有的构建 Token">
        这次没换。之后面板装插件时提示它失效了，再重新建一个写入即可。
      </Callout>
      <Callout v-else-if="!c.buildsTokenWritten" tone="warning" title="没有配置构建 Token">
        在补配之前，面板上装插件会直接失败（提示「自部署未配置」）。补法写在 run 页的 Summary 里。
      </Callout>
      <Callout v-for="(warning, i) in result.warnings" :key="i" tone="warning">{{ warning }}</Callout>
    </div>

    <NextSteps :result="result" />
    <DeployInfo :result="result" />
    <CloseCard :closes-at="c.closesAt" />
  </div>
</template>
