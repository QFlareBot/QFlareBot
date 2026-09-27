<script setup lang="ts">
/** 一轮模拟的细节：会话解析、命中的插件、错误、交互回应、流式分片、撤回；默认折叠 */
import { ChevronDown } from 'lucide-vue-next'
import type { TestEventResult } from '../../api/types.js'
import QBadge from '../ui/QBadge.vue'
import QCode from '../ui/QCode.vue'

defineProps<{ result: TestEventResult; open: boolean }>()
const emit = defineEmits<{ toggle: [] }>()

const SCENE: Record<string, string> = { group: '群聊', c2c: '单聊', guild: '频道', guild_dm: '频道私信', unknown: '未知' }
</script>

<template>
  <div class="max-w-[min(34rem,100%)] text-xs">
    <button type="button" class="inline-flex cursor-pointer items-center gap-1 text-fg-subtle hover:text-fg" :aria-expanded="open" @click="emit('toggle')">
      <ChevronDown class="size-3 transition-transform duration-(--qb-duration-slow)" :class="open && 'rotate-180'" aria-hidden="true" />
      {{ result.matched.length }} 个处理器命中<template v-if="result.errors.length"> · <span class="text-danger">{{ result.errors.length }} 个错误</span></template>
    </button>
    <div v-if="open" class="mt-2 flex flex-col gap-2 rounded-lg border border-border bg-surface-muted/60 p-3">
      <dl class="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
        <div><dt class="text-fg-muted">事件</dt><dd class="font-mono break-all">{{ result.session.event }}</dd></div>
        <div><dt class="text-fg-muted">场景</dt><dd>{{ SCENE[result.session.scene] ?? result.session.scene }}</dd></div>
        <div><dt class="text-fg-muted">可被动回复</dt><dd>{{ result.session.canReply ? '是' : '否' }}</dd></div>
        <div><dt class="text-fg-muted">发送者</dt><dd class="font-mono break-all">{{ result.session.userId }}</dd></div>
        <div v-if="result.session.interaction" class="col-span-2">
          <dt class="text-fg-muted">交互</dt>
          <dd class="font-mono">{{ result.session.interaction.type }} · {{ result.session.interaction.buttonId }}</dd>
        </div>
      </dl>
      <div class="flex flex-wrap gap-1">
        <QBadge v-for="m in result.matched" :key="m.plugin + m.kind + m.name" tone="accent">{{ m.plugin }} · {{ m.kind }} · {{ m.name }}</QBadge>
        <span v-if="!result.matched.length" class="text-fg-muted">没有插件命中这条事件</span>
      </div>
      <ul v-if="result.errors.length" class="flex flex-col gap-1">
        <li v-for="(e, i) in result.errors" :key="i" class="rounded-md bg-danger-bg px-2.5 py-2">
          <p class="text-danger">{{ e.plugin }} · {{ e.stage }}</p>
          <p class="font-mono break-words text-danger">{{ e.message }}</p>
        </li>
      </ul>
      <p v-if="result.acks.length" class="text-fg-muted">
        交互回应：<template v-for="(a, i) in result.acks" :key="a.interactionId">{{ i ? '、' : '' }}code {{ a.code }}</template>
      </p>
      <p v-if="result.recalls.length" class="text-fg-muted">撤回 {{ result.recalls.length }} 条消息</p>
      <div v-if="result.streams.length">
        <p class="mb-1 text-fg-muted">流式分片（{{ result.streams.length }}）</p>
        <QCode :value="result.streams" />
      </div>
    </div>
  </div>
</template>
