<script setup lang="ts">
/**
 * 按 JSON Schema 渲染配置表单。覆盖插件配置常见的五种：string（含 enum）、number/integer、boolean、string[]，
 * 其余类型退化为 JSON 文本框。
 */
import { computed } from 'vue'
import type { JsonSchema } from '../api/types.js'
import QField from './ui/QField.vue'
import QInput from './ui/QInput.vue'
import QSelect from './ui/QSelect.vue'
import QSwitch from './ui/QSwitch.vue'
import QTextarea from './ui/QTextarea.vue'

const props = defineProps<{ schema: JsonSchema; modelValue: Record<string, unknown>; errors?: Record<string, string> }>()
const emit = defineEmits<{ 'update:modelValue': [value: Record<string, unknown>] }>()

const fields = computed(() => Object.entries(props.schema.properties ?? {}))
const required = computed(() => new Set(props.schema.required ?? []))

function set(key: string, value: unknown) {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}

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
function parseJson(key: string, text: string) {
  try {
    set(key, text.trim() ? JSON.parse(text) : undefined)
  } catch {
    // 用户还在输入，保持原值
  }
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
      :error="errors?.[key]"
      :required="required.has(key)"
    >
      <template #default="{ describedBy, invalid }">
        <QSelect
          v-if="kind(s) === 'enum'"
          :id="`cfg-${key}`"
          :model-value="str(modelValue[key] ?? s.default)"
          :options="(s.enum ?? []).map((v) => ({ value: String(v), label: String(v) }))"
          @update:model-value="set(key, $event)"
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
          :model-value="jsonText(modelValue[key])"
          mono
          :rows="4"
          placeholder="JSON"
          :described-by="describedBy"
          @update:model-value="parseJson(key, $event)"
        />
      </template>
    </QField>
    <p v-if="!fields.length" class="text-sm text-fg-muted">该插件没有声明配置项。</p>
  </div>
</template>
