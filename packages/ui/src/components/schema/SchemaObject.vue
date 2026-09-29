<script setup lang="ts">
/**
 * 对象：按 properties 的顺序逐项渲染，改哪一项就换掉哪一项（不可变更新），schema 里没声明的键原样保留。
 * 写了 x-showIf 的字段只在同级字段满足条件时出现；藏起来的值照样保留，服务端也不校验它（见 isShown）。
 * saved / defaults 是这一层已保存的值与出厂默认，按键分给子字段。
 */
import { computed, toRaw } from 'vue'
import type { JsonSchema } from '../../api/types.js'
import { asRecord, getOwn, joinId, joinPath, setIn } from '../../lib/schemaForm.js'
import { childDefault, isShown } from '../../lib/schemaState.js'
import SchemaField from './SchemaField.vue'

const props = defineProps<{
  schema: JsonSchema
  modelValue: unknown
  path: string
  id: string
  errors?: Record<string, string>
  track?: boolean
  saved?: unknown
  defaults?: unknown
}>()
const emit = defineEmits<{ 'update:modelValue': [value: Record<string, unknown>] }>()

const value = computed(() => asRecord(props.modelValue))
const fields = computed(() => Object.entries(props.schema.properties ?? {}).filter(([, s]) => isShown(s, value.value)))
const required = computed(() => new Set(props.schema.required ?? []))

function set(key: string, v: unknown) {
  emit('update:modelValue', setIn(toRaw(value.value), [key], v) as Record<string, unknown>)
}
</script>

<template>
  <TransitionGroup name="list" tag="div" class="flex flex-col gap-4">
    <SchemaField
      v-for="[key, s] in fields"
      :key="key"
      :schema="s"
      :model-value="getOwn(value, key)"
      :path="joinPath(path, key)"
      :id="joinId(id, key)"
      :label="s.title ?? key"
      :required="required.has(key)"
      :errors="errors"
      :track="track"
      :saved="getOwn(asRecord(saved), key)"
      :default-value="childDefault(defaults, key, s)"
      @update:model-value="set(key, $event)"
    />
  </TransitionGroup>
</template>
