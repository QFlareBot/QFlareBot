<script setup lang="ts">
/** 按 QQ 的样子预览 markdown；只渲染成节点，不用 v-html */
import { computed } from 'vue'
import { parseMarkdown, type Inline } from '../../lib/miniMarkdown.js'

const props = defineProps<{ source: string }>()
const blocks = computed(() => parseMarkdown(props.source))
const inlineKey = (x: Inline, i: number) => `${i}-${x.t}`
</script>

<template>
  <div class="flex flex-col gap-1.5 break-words">
    <template v-for="(b, i) in blocks" :key="i">
      <pre v-if="b.t === 'code'" class="overflow-x-auto rounded-md bg-surface-muted px-2.5 py-1.5 font-mono text-xs whitespace-pre-wrap">{{ b.v }}</pre>
      <hr v-else-if="b.t === 'hr'" class="border-border" />
      <component
        :is="b.t === 'h' ? 'p' : b.t === 'quote' ? 'blockquote' : 'p'"
        v-else
        class="whitespace-pre-wrap"
        :class="{
          'text-base font-semibold': b.t === 'h' && b.level <= 2,
          'font-semibold': b.t === 'h' && b.level > 2,
          'border-l-2 border-border-strong pl-2.5 text-fg-muted': b.t === 'quote',
          'flex gap-1.5': b.t === 'li',
        }"
      >
        <span v-if="b.t === 'li'" class="shrink-0 text-fg-muted">{{ b.marker }}</span>
        <span>
          <template v-for="(x, j) in b.inl" :key="inlineKey(x, j)">
            <code v-if="x.t === 'code'" class="rounded bg-surface-muted px-1 font-mono text-[0.9em]">{{ x.v }}</code>
            <strong v-else-if="x.t === 'bold'" class="font-semibold">{{ x.v }}</strong>
            <em v-else-if="x.t === 'italic'">{{ x.v }}</em>
            <a v-else-if="x.t === 'link'" :href="x.href" target="_blank" rel="noopener" class="text-accent underline underline-offset-2">{{ x.v }}</a>
            <img v-else-if="x.t === 'image'" :src="x.src" :alt="x.alt" referrerpolicy="no-referrer" class="my-1 block max-h-56 rounded-lg border border-border" />
            <template v-else>{{ x.v }}</template>
          </template>
        </span>
      </component>
    </template>
  </div>
</template>
