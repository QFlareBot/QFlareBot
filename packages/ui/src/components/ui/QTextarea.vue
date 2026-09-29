<script setup lang="ts">
/**
 * 多行文本：跟着内容长高（rows 是最少几行，最高到 60% 视口再在里面滚动），不用浏览器右下角的拖拽手柄。
 * 支持 field-sizing: content 的浏览器交给 CSS；不支持的（Firefox 等）按 scrollHeight 算高度。
 */
import { nextTick, onMounted, ref, watch } from 'vue'

const props = defineProps<{ modelValue: string; rows?: number; id?: string; mono?: boolean; placeholder?: string; invalid?: boolean; describedBy?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const el = ref<HTMLTextAreaElement | null>(null)
const native = typeof CSS !== 'undefined' && CSS.supports('field-sizing', 'content')

function fit() {
  const t = el.value
  if (native || !t) return
  t.style.height = 'auto'
  // Tailwind 的 box-sizing 是 border-box：scrollHeight 不含上下两条 1px 边框
  t.style.height = `${t.scrollHeight + 2}px`
}
onMounted(fit)
watch(
  () => props.modelValue,
  () => void nextTick(fit),
)
</script>

<template>
  <textarea
    ref="el"
    :id="id"
    :rows="rows ?? 4"
    :value="modelValue"
    :placeholder="placeholder"
    :aria-invalid="invalid || undefined"
    :aria-describedby="describedBy"
    class="qb-control max-h-[60vh] w-full resize-none overflow-y-auto px-3 py-2 text-sm [field-sizing:content]"
    :class="[invalid && 'qb-control--invalid', mono && 'font-mono text-xs leading-relaxed']"
    :style="{ minHeight: `calc(${rows ?? 4}lh + 1rem + 2px)` }"
    @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
  />
</template>
