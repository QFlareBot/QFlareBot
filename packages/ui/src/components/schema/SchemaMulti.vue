<script setup lang="ts">
/**
 * 多选（数组的 items 是 enum / 带 const 的 oneOf）：一排可按下的标签，按下即选中。
 * 写回时按选项的顺序排；已存的值里有选项之外的（插件升级删了选项）也列出来，点一下就能去掉。
 */
import { Check } from 'lucide-vue-next'
import { computed } from 'vue'
import type { JsonSchema } from '../../api/types.js'
import { enumIndex, multiChoices } from '../../lib/schemaForm.js'

const props = defineProps<{ schema: JsonSchema; modelValue: unknown; id: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: unknown[]] }>()

const choices = computed(() => multiChoices(props.schema) ?? { values: [], labels: [] })
const picked = computed(() => (Array.isArray(props.modelValue) ? (props.modelValue as unknown[]) : []))
const isPicked = (v: unknown) => enumIndex(picked.value, v) >= 0
/** 已存、但不在选项里的值 */
const strays = computed(() => picked.value.filter((v) => enumIndex(choices.value.values, v) < 0))

function toggle(i: number) {
  const on = !isPicked(choices.value.values[i])
  const next = choices.value.values.filter((c, j) => (j === i ? on : isPicked(c)))
  emit('update:modelValue', [...next, ...strays.value])
}
function dropStray(v: unknown) {
  emit('update:modelValue', picked.value.filter((p) => p !== v))
}
const strayLabel = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v))

const chip =
  'inline-flex h-8 cursor-pointer items-center gap-1 rounded-full border px-3 text-sm transition-[background-color,border-color,color,transform] duration-(--qb-duration) active:scale-95'
</script>

<template>
  <div :id="id" class="flex flex-wrap gap-1.5">
    <button
      v-for="(v, i) in choices.values"
      :key="i"
      type="button"
      :class="[chip, isPicked(v) ? 'border-transparent bg-primary font-medium text-on-primary' : 'border-border-strong text-fg-muted hover:bg-surface-muted hover:text-fg']"
      :aria-pressed="isPicked(v)"
      @click="toggle(i)"
    >
      <Check v-if="isPicked(v)" class="qb-pop -ml-0.5 size-3.5" aria-hidden="true" />{{ choices.labels[i] }}
    </button>
    <button
      v-for="(v, i) in strays"
      :key="`stray-${i}`"
      type="button"
      :class="[chip, 'border-dashed border-warning/60 text-warning hover:bg-warning-bg']"
      :aria-label="`${strayLabel(v)}（已不在可选项里），点击去掉`"
      @click="dropStray(v)"
    >
      {{ strayLabel(v) }}<span class="text-xs">· 已失效</span>
    </button>
  </div>
</template>
