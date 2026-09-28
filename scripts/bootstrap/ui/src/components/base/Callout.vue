<script setup lang="ts">
/** 提示条：状态色旁边一定有图标和文字；busy 时底边走一条不定进度条 */
import { CircleCheck, CircleX, Info, TriangleAlert } from 'lucide-vue-next'
import { computed } from 'vue'

const props = withDefaults(defineProps<{ tone?: 'info' | 'success' | 'warning' | 'danger'; title?: string; busy?: boolean }>(), { tone: 'info' })

const look = computed(
  () =>
    ({
      info: { icon: Info, box: 'bg-surface-muted', accent: 'text-fg-muted' },
      success: { icon: CircleCheck, box: 'bg-success-bg', accent: 'text-success' },
      warning: { icon: TriangleAlert, box: 'bg-warning-bg', accent: 'text-warning' },
      danger: { icon: CircleX, box: 'bg-danger-bg', accent: 'text-danger' },
    })[props.tone],
)
</script>

<template>
  <div class="relative flex gap-3 overflow-hidden rounded-md px-3.5 py-3 text-sm" :class="look.box">
    <component :is="look.icon" class="mt-0.5 size-4 shrink-0" :class="look.accent" aria-hidden="true" />
    <div class="min-w-0 flex-1">
      <p v-if="title" class="font-medium text-pretty" :class="look.accent">{{ title }}</p>
      <div class="text-pretty text-fg-muted [&_a]:font-medium [&_a]:text-accent [&_a]:underline-offset-2 hover:[&_a]:underline" :class="title && 'mt-0.5'">
        <slot />
      </div>
    </div>
    <span v-if="busy" class="qb-progress" :class="look.accent" aria-hidden="true" />
  </div>
</template>
