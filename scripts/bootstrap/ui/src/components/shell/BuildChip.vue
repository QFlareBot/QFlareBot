<script setup lang="ts">
/** 补跑构建的小标签：挂在步骤栏底部（手机上在内容顶上），走到哪一步都看得到构建结果 */
import { ArrowUpRight } from 'lucide-vue-next'
import { computed } from 'vue'
import { buildSummary } from '../../lib/build.js'
import { serverNow } from '../../lib/clock.js'
import { useWizard } from '../../wizard.js'

const w = useWizard()
const summary = computed(() => buildSummary(w.connection.value, serverNow.value))
</script>

<template>
  <Transition name="swap" type="transition">
    <a
      v-if="summary"
      :href="w.connection.value?.buildsUrl ?? undefined"
      target="_blank"
      rel="noopener noreferrer"
      class="flex items-center gap-2.5 rounded-md border border-border bg-surface/70 px-3 py-2 text-xs transition-colors duration-(--qb-duration) hover:bg-surface"
      :title="summary.title"
    >
      <span
        class="size-2 shrink-0 rounded-full"
        :class="[{ ok: 'bg-success', run: 'bg-accent', warn: 'bg-warning', fail: 'bg-danger' }[summary.state], summary.state === 'run' && 'qb-pulse']"
        aria-hidden="true"
      />
      <span class="min-w-0 flex-1">
        <span class="block font-medium text-fg">补跑构建</span>
        <span class="block truncate text-fg-muted tabular-nums">{{ summary.short }}</span>
      </span>
      <ArrowUpRight class="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
      <span class="sr-only">打开构建记录</span>
    </a>
  </Transition>
</template>
