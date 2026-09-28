<script setup lang="ts">
/** 连接检测的状态：没连上时是一圈圈的波纹在等；连上后逐项亮起（连接、构建配置、补跑构建） */
import { computed } from 'vue'
import { buildSummary } from '../../lib/build.js'
import { localNow, serverNow } from '../../lib/clock.js'
import type { Connection } from '../../types.js'
import Callout from '../base/Callout.vue'
import CheckRow from '../base/CheckRow.vue'
import StepCard from '../base/StepCard.vue'

const props = defineProps<{ connection: Connection | null; since: number }>()
const c = computed(() => props.connection)
const build = computed(() => buildSummary(c.value, serverNow.value))
/** 等了 45 秒还没动静，才提示「也可能是 token 缺权限」：没点 Connect 之前报红只会吓人 */
const waitedLong = computed(() => localNow.value - props.since > 45_000)
</script>

<template>
  <StepCard>
    <Transition name="swap" type="transition" mode="out-in">
      <div v-if="!c?.connected" key="waiting" aria-live="polite">
        <div class="flex items-center gap-4">
          <span class="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary text-accent" aria-hidden="true">
            <span class="qb-radar size-2.5 rounded-full bg-accent" />
          </span>
          <div class="min-w-0">
            <p class="text-sm font-medium text-fg">等你在 Cloudflare 点 Connect</p>
            <p class="mt-0.5 text-xs text-pretty text-fg-muted">每 3 秒自动检测一次。连上后这里会亮起来，不用回来点任何按钮。</p>
          </div>
        </div>
        <Callout v-if="waitedLong && c?.maybeMissingPermission" tone="warning" class="mt-4">
          已经连好了还停在这里的话：{{ c.maybeMissingPermission }}。补完这里会自动继续。
        </Callout>
        <p v-if="c?.detectError" class="mt-3 text-xs break-words text-fg-subtle">检测出错，会继续重试：{{ c.detectError }}</p>
      </div>

      <div v-else key="connected">
        <ul class="space-y-4" aria-live="polite">
          <CheckRow state="ok" title="已连接仓库" :detail="`生产分支 ${c.branch}`" />
          <CheckRow
            :state="c.configured ? 'ok' : 'fail'"
            :title="!c.configured ? '构建配置没写进去' : c.unchanged ? '构建配置和上次一致' : '构建配置已写入'"
            :detail="
              !c.configured
                ? `${c.error ?? '原因未知'}。下一步粘贴构建 Token 后会用它再试一次。`
                : c.unchanged
                  ? '构建命令、排除路径、构建缓存和清单变量本来就是对的，这次没有改动。'
                  : '构建命令、排除路径、构建缓存和 MANIFEST_URL / MANIFEST_TOKEN 都写好了，Cloudflare 后台一个格子都不用填。'
            "
          />
          <CheckRow v-if="build" :state="build.state" :title="build.title" :detail="build.detail" :href="c.buildsUrl" />
        </ul>
        <p class="mt-4 text-xs text-fg-subtle">连接那一刻 Cloudflare 自己跑的那次构建如果失败了，不用管。</p>
      </div>
    </Transition>
  </StepCard>
</template>
