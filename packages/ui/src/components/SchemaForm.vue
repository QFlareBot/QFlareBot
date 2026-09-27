<script setup lang="ts">
/**
 * 按 JSON Schema 渲染配置表单。覆盖插件配置常见的五种：string（含 enum）、number/integer、boolean、string[]，
 * 其余类型退化为 JSON 文本框。
 *
 * JSON 文本框解析不了的时候不改 modelValue，只在字段下报错，并通过 `invalid` 事件把这些字段名告诉父组件——
 * 父组件据此拦住保存，不然点保存会把旧值当成「已保存」。
 */
import { computed, onBeforeUnmount, shallowReactive, toRaw, watch } from 'vue'
import type { JsonSchema } from '../api/types.js'
import { enumIndex, enumOptions, enumValueAt, parseJsonDraft } from '../lib/schemaForm.js'
import QField from './ui/QField.vue'
import QInput from './ui/QInput.vue'
import QSelect from './ui/QSelect.vue'
import QSwitch from './ui/QSwitch.vue'
import QTextarea from './ui/QTextarea.vue'

const props = defineProps<{ schema: JsonSchema; modelValue: Record<string, unknown>; errors?: Record<string, string> }>()
const emit = defineEmits<{
  'update:modelValue': [value: Record<string, unknown>]
  /** JSON 文本框里还解析不了的字段；非空时不该保存 */
  invalid: [keys: string[]]
}>()

const fields = computed(() => Object.entries(props.schema.properties ?? {}))
const required = computed(() => new Set(props.schema.required ?? []))

function set(key: string, value: unknown) {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}

/**
 * JSON 文本框里用户敲的原文。只要它还对应着当前的值就一直显示原文：解析失败时原样留着让人改，
 * 合法时也不按 JSON.stringify 重排——重排会把光标甩到末尾。
 * base 是这份原文对应的 modelValue[key]；父组件换了值（重新加载、保存后刷新）就对不上，原文作废。
 */
const drafts = shallowReactive<Record<string, { text: string; base: unknown; error: string }>>({})

function onJsonInput(key: string, text: string) {
  const parsed = parseJsonDraft(text)
  if (parsed.ok) {
    drafts[key] = { text, base: parsed.value, error: '' }
    set(key, parsed.value)
  } else {
    drafts[key] = { text, base: props.modelValue[key], error: parsed.error }
  }
}

// 比较时去掉响应式代理：父组件把值存进 ref 之后读回来的是代理，与我们 emit 出去的原对象不是同一个引用
watch(
  () => props.modelValue,
  (value) => {
    for (const [key, d] of Object.entries(drafts)) if (toRaw(value[key]) !== toRaw(d.base)) delete drafts[key]
  },
)

const invalidKeys = computed(() => fields.value.map(([key]) => key).filter((key) => drafts[key]?.error))
watch(
  () => invalidKeys.value.join('\n'),
  () => emit('invalid', invalidKeys.value),
)
onBeforeUnmount(() => emit('invalid', []))

function kind(s: JsonSchema): 'enum' | 'string' | 'number' | 'boolean' | 'string[]' | 'json' {
  if (s.enum) return 'enum'
  if (s.type === 'string') return 'string'
  if (s.type === 'number' || s.type === 'integer') return 'number'
  if (s.type === 'boolean') return 'boolean'
  if (s.type === 'array' && s.items?.type === 'string') return 'string[]'
  return 'json'
}

function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v)
}
function lines(v: unknown): string {
  return Array.isArray(v) ? v.join('\n') : ''
}
function jsonText(v: unknown): string {
  return v === undefined ? '' : JSON.stringify(v, null, 2)
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <QField
      v-for="[key, s] in fields"
      :key="key"
      :id="`cfg-${key}`"
      :label="s.title ?? key"
      :hint="s.description"
      :error="drafts[key]?.error || errors?.[key]"
      :required="required.has(key)"
    >
      <template #default="{ describedBy, invalid }">
        <QSelect
          v-if="kind(s) === 'enum'"
          :id="`cfg-${key}`"
          :model-value="String(enumIndex(s.enum ?? [], modelValue[key] ?? s.default))"
          :options="enumOptions(s.enum ?? [])"
          @update:model-value="set(key, enumValueAt(s.enum ?? [], $event))"
        />
        <QInput
          v-else-if="kind(s) === 'string'"
          :id="`cfg-${key}`"
          :model-value="str(modelValue[key])"
          :placeholder="str(s.default)"
          :described-by="describedBy"
          :invalid="invalid"
          @update:model-value="set(key, $event)"
        />
        <QInput
          v-else-if="kind(s) === 'number'"
          :id="`cfg-${key}`"
          type="number"
          :model-value="str(modelValue[key])"
          :placeholder="str(s.default)"
          :described-by="describedBy"
          :invalid="invalid"
          @update:model-value="set(key, $event === '' ? undefined : Number($event))"
        />
        <div v-else-if="kind(s) === 'boolean'" class="-ml-3 flex items-center gap-1">
          <QSwitch :model-value="!!(modelValue[key] ?? s.default)" :label="s.title ?? key" @update:model-value="set(key, $event)" />
          <span class="text-sm text-fg-muted">{{ modelValue[key] ?? s.default ? '开' : '关' }}</span>
        </div>
        <QTextarea
          v-else-if="kind(s) === 'string[]'"
          :id="`cfg-${key}`"
          :model-value="lines(modelValue[key])"
          placeholder="每行一项"
          :rows="3"
          :described-by="describedBy"
          @update:model-value="set(key, $event.split('\n').map((l) => l.trim()).filter(Boolean))"
        />
        <QTextarea
          v-else
          :id="`cfg-${key}`"
          :model-value="drafts[key]?.text ?? jsonText(modelValue[key])"
          mono
          :rows="4"
          placeholder="JSON"
          :described-by="describedBy"
          :invalid="invalid"
          @update:model-value="onJsonInput(key, $event)"
        />
      </template>
    </QField>
    <p v-if="!fields.length" class="text-sm text-fg-muted">该插件没有声明配置项。</p>
  </div>
</template>
