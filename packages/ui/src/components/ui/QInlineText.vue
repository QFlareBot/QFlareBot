<script setup lang="ts">
/**
 * 一段带行内 Markdown 的说明文字：链接、`代码`、**粗体**、*斜体*（插件配置字段的 description 用）。
 * 解析复用 lib/miniMarkdown，只产出节点、不拼 HTML；链接只认 http(s)，新窗口打开。图片不展开，只留描述文字。
 */
import { computed } from 'vue'
import { parseInline } from '../../lib/miniMarkdown.js'

const props = defineProps<{ text: string }>()
const parts = computed(() => parseInline(props.text))
</script>

<template>
  <span class="whitespace-pre-line">
    <template v-for="(x, i) in parts" :key="`${i}-${x.t}`">
      <a
        v-if="x.t === 'link'"
        :href="x.href"
        target="_blank"
        rel="noopener noreferrer"
        class="font-medium text-fg underline decoration-border-strong underline-offset-2 transition-colors duration-(--qb-duration) hover:decoration-fg"
        >{{ x.v }}</a
      >
      <code v-else-if="x.t === 'code'" class="rounded-sm bg-surface-muted px-1 py-px font-mono text-[0.92em] text-fg">{{ x.v }}</code>
      <strong v-else-if="x.t === 'bold'" class="font-semibold text-fg">{{ x.v }}</strong>
      <em v-else-if="x.t === 'italic'">{{ x.v }}</em>
      <template v-else-if="x.t === 'image'">{{ x.alt }}</template>
      <template v-else>{{ x.v }}</template>
    </template>
  </span>
</template>
