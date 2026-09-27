<script setup lang="ts">
/** 机器人的一条回复，照 QQ 的样子画：文字、markdown、图片、富媒体、按键；按键能点 */
import { Braces, CornerDownLeft, ExternalLink, Image, Quote } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import { previewMessage, type PreviewButton } from '../../lib/outgoing.js'
import QCode from '../ui/QCode.vue'
import MarkdownView from './MarkdownView.vue'

const props = defineProps<{ message: unknown; label?: string }>()
const emit = defineEmits<{ button: [button: PreviewButton] }>()
const view = computed(() => previewMessage(props.message))
const raw = ref(false)

const buttonClass = (b: PreviewButton) =>
  ({
    1: 'border-accent/50 text-accent',
    3: 'border-border-strong text-danger',
    4: 'border-transparent bg-primary text-on-primary',
  })[b.style] ?? 'border-border-strong text-fg'

const MEDIA: Record<string, string> = { video: '视频', voice: '语音', file: '文件' }
</script>

<template>
  <div class="flex max-w-[min(34rem,100%)] flex-col gap-1.5">
    <div class="rounded-2xl rounded-tl-md border border-card-border bg-surface px-3.5 py-2.5 text-sm text-fg shadow-card">
      <p v-if="view.quote" class="mb-1.5 flex items-center gap-1 text-xs text-fg-subtle"><Quote class="size-3" aria-hidden="true" />引用了收到的消息</p>
      <p v-if="view.text" class="break-words whitespace-pre-wrap">{{ view.text }}</p>
      <MarkdownView v-if="view.markdown" :source="view.markdown" :class="view.text && 'mt-2'" />
      <img v-if="view.image" :src="view.image" alt="插件回复的图片" referrerpolicy="no-referrer" class="mt-1 max-h-64 rounded-lg border border-border" />
      <p v-if="view.media" class="mt-1 flex items-center gap-1.5 text-xs text-fg-muted">
        <Image class="size-3.5" aria-hidden="true" />[{{ MEDIA[view.media.type] ?? view.media.type }}] <span class="truncate font-mono">{{ view.media.label }}</span>
      </p>
      <p v-if="!view.text && !view.markdown && !view.image && !view.media && !view.keyboard.length" class="text-xs text-fg-subtle">（空消息）</p>
    </div>

    <div v-if="view.keyboard.length" class="flex flex-col gap-1.5">
      <div v-for="(row, r) in view.keyboard" :key="r" class="flex gap-1.5">
        <button
          v-for="b in row"
          :key="b.id"
          type="button"
          class="flex h-8 min-w-0 flex-1 cursor-pointer items-center justify-center gap-1 rounded-lg border bg-surface px-2 text-xs font-medium transition-[background-color,transform] duration-(--qb-duration) hover:bg-surface-muted active:scale-[0.97]"
          :class="buttonClass(b)"
          :title="b.action === 0 ? `打开 ${b.data}` : b.action === 2 ? `填入指令 ${b.data}` : `回调 ${b.id}${b.data ? ` · ${b.data}` : ''}`"
          @click="emit('button', b)"
        >
          <span class="truncate">{{ b.label }}</span>
          <ExternalLink v-if="b.action === 0" class="size-3 shrink-0" aria-hidden="true" />
          <CornerDownLeft v-else-if="b.action === 2" class="size-3 shrink-0" aria-hidden="true" />
        </button>
      </div>
    </div>
    <p v-if="view.keyboardTemplate" class="text-xs text-fg-subtle">按键模板 {{ view.keyboardTemplate }}（内容由平台渲染，这里看不到）</p>

    <div class="flex items-center gap-2 text-xs text-fg-subtle">
      <span v-if="label">{{ label }}</span>
      <button type="button" class="inline-flex cursor-pointer items-center gap-1 hover:text-fg" :aria-expanded="raw" @click="raw = !raw">
        <Braces class="size-3" aria-hidden="true" />{{ raw ? '收起原始数据' : '原始数据' }}
      </button>
    </div>
    <QCode v-if="raw" :value="message" />
  </div>
</template>
