<script setup lang="ts">
/**
 * 按 JSON Schema 渲染插件配置表单。这里只管顶层对象；各类字段（嵌套对象、对象数组、键值映射、
 * 带标签的下拉、多行文本、密钥……）在 schema/ 下，按 fieldKind 递归分派，认不出的退成 JSON 文本框。
 *
 * 还不能保存的字段（JSON 解析不了、映射的键重复或空着）不改 modelValue，只在字段下报错，
 * 并通过 `invalid` 事件把它们的点分路径告诉父组件——父组件据此拦住保存，不然点保存会把旧值当成「已保存」。
 * errors 是服务端校验的逐字段错误，键同样是点分路径（顶层字段就是键名）。
 */
import { computed, onBeforeUnmount, watch } from 'vue'
import type { JsonSchema } from '../api/types.js'
import { provideInvalid } from './schema/invalid.js'
import SchemaObject from './schema/SchemaObject.vue'

const props = defineProps<{
  schema: JsonSchema
  modelValue: Record<string, unknown>
  errors?: Record<string, string>
  /** 已保存的配置：改过的字段标出来 */
  saved?: unknown
  /** 插件的 defaultConfig：和它不一样的字段给「恢复默认」；没有时只看 schema 里的 default */
  defaults?: unknown
}>()
const emit = defineEmits<{
  'update:modelValue': [value: Record<string, unknown>]
  /** 还不能保存的字段路径；非空时不该保存 */
  invalid: [paths: string[]]
}>()

const hasFields = computed(() => Object.keys(props.schema.properties ?? {}).length > 0)

const invalidPaths = provideInvalid()
watch(
  () => JSON.stringify(invalidPaths.value),
  () => emit('invalid', invalidPaths.value),
)
onBeforeUnmount(() => emit('invalid', []))
</script>

<template>
  <SchemaObject
    v-if="hasFields"
    :schema="schema"
    :model-value="modelValue"
    path=""
    id="cfg"
    :errors="errors"
    track
    :saved="saved"
    :defaults="defaults"
    @update:model-value="emit('update:modelValue', $event)"
  />
  <p v-else class="text-sm text-fg-muted">该插件没有声明配置项。</p>
</template>
