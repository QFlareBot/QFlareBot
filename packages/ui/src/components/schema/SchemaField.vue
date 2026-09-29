<script setup lang="ts">
/**
 * 一个配置项：按 schema 选控件（fieldKind），对象、对象数组、映射再往下递归。
 * 认不出的类型退成 JSON 文本框，原文草稿归这里管：解析不了时不往外写值，只在字段下报错并登记路径，
 * SchemaForm 据此告诉父组件拦住保存——不然点保存会把改之前的旧值当成「已保存」。
 *
 * track 时和 saved（已保存的值）、defaultValue（出厂默认）比：改过就在标签旁点一个圆点，和默认不一样就给「恢复默认」。
 * 固定字段的对象不标自己，由里面的字段各自标；卡片列表、映射里的项不逐个标（新加、挪动的项满屏都是圆点），标在整组上。
 */
import { computed, ref, shallowRef, toRaw, watch } from 'vue'
import type { JsonSchema } from '../../api/types.js'
import { fieldKind, getOwn, isGroupKind, parseJsonDraft } from '../../lib/schemaForm.js'
import { sameValue } from '../../lib/schemaState.js'
import QTextarea from '../ui/QTextarea.vue'
import { useInvalid } from './invalid.js'
import SchemaArray from './SchemaArray.vue'
import SchemaFrame from './SchemaFrame.vue'
import SchemaMap from './SchemaMap.vue'
import SchemaMulti from './SchemaMulti.vue'
import SchemaObject from './SchemaObject.vue'
import SchemaScalar from './SchemaScalar.vue'
import SchemaSecret from './SchemaSecret.vue'

const props = defineProps<{
  schema: JsonSchema
  modelValue: unknown
  /** 点分路径，与服务端校验错误的 path 对得上 */
  path: string
  id: string
  label: string
  required?: boolean
  bare?: boolean
  errors?: Record<string, string>
  /** 标不标「改过 / 恢复默认」 */
  track?: boolean
  /** 这个字段已保存的值 */
  saved?: unknown
  /** 这个字段的出厂默认；undefined 表示没有默认 */
  defaultValue?: unknown
}>()
const emit = defineEmits<{ 'update:modelValue': [value: unknown] }>()

const kind = computed(() => fieldKind(props.schema))

const marks = computed(() => props.track && kind.value !== 'object')
const modified = computed(() => marks.value && !sameValue(toRaw(props.modelValue), toRaw(props.saved)))
// 密钥不给恢复：默认值要么没有、要么是占位，恢复出去的只会是空
const resettable = computed(
  () => marks.value && kind.value !== 'secret' && props.defaultValue !== undefined && !sameValue(toRaw(props.modelValue), props.defaultValue),
)
function reset() {
  emit('update:modelValue', structuredClone(toRaw(props.defaultValue)))
}

/**
 * JSON 文本框里用户敲的原文。只要它还对应着当前的值就一直显示原文：解析失败时原样留着让人改，
 * 合法时也不按 JSON.stringify 重排——重排会把光标甩到末尾。
 * base 是这份原文对应的值；外面换了值（重新加载、保存后刷新）就对不上，原文作废。
 */
const draft = shallowRef<{ text: string; base: unknown; error: string } | null>(null)

function onJsonInput(text: string) {
  const parsed = parseJsonDraft(text)
  if (parsed.ok) {
    draft.value = { text, base: parsed.value, error: '' }
    emit('update:modelValue', parsed.value)
  } else {
    draft.value = { text, base: props.modelValue, error: parsed.error }
  }
}

// 比较时去掉响应式代理：父组件把值存进 ref 之后读回来的是代理，与我们 emit 出去的原对象不是同一个引用
watch(
  () => props.modelValue,
  (v) => {
    if (draft.value && toRaw(v) !== toRaw(draft.value.base)) draft.value = null
  },
)
/** 数字框里还不合格的内容（不是数字、超出范围）：同样不写值、报错并拦住保存 */
const problem = ref('')
useInvalid(() => (draft.value?.error || problem.value ? [props.path] : []))

const error = computed(() => draft.value?.error || problem.value || getOwn(props.errors, props.path))

function jsonText(v: unknown): string {
  return v === undefined ? '' : JSON.stringify(v, null, 2)
}
</script>

<template>
  <SchemaFrame
    v-if="isGroupKind(kind)"
    group
    :boxed="kind === 'object'"
    :id="id"
    :label="label"
    :hint="schema.description"
    :error="error"
    :required="required"
    :bare="bare"
    :modified="modified"
    :resettable="resettable"
    @reset="reset"
  >
    <SchemaObject
      v-if="kind === 'object'"
      :schema="schema"
      :model-value="modelValue"
      :path="path"
      :id="id"
      :errors="errors"
      :track="track"
      :saved="saved"
      :defaults="defaultValue"
      @update:model-value="emit('update:modelValue', $event)"
    />
    <SchemaMulti v-else-if="kind === 'multi'" :schema="schema" :model-value="modelValue" :id="id" @update:model-value="emit('update:modelValue', $event)" />
    <SchemaArray v-else-if="kind === 'object[]'" :schema="schema" :model-value="modelValue" :path="path" :id="id" :label="label" :errors="errors" @update:model-value="emit('update:modelValue', $event)" />
    <SchemaMap v-else :schema="schema" :model-value="modelValue" :path="path" :id="id" :label="label" :errors="errors" @update:model-value="emit('update:modelValue', $event)" />
  </SchemaFrame>

  <SchemaFrame
    v-else
    :id="id"
    :label="label"
    :hint="schema.description"
    :error="error"
    :required="required"
    :bare="bare"
    :modified="modified"
    :resettable="resettable"
    @reset="reset"
  >
    <template #default="{ describedBy, invalid }">
      <SchemaSecret v-if="kind === 'secret'" :id="id" :label="label" :model-value="modelValue" :described-by="describedBy" :invalid="invalid" @update:model-value="emit('update:modelValue', $event)" />
      <QTextarea
        v-else-if="kind === 'json'"
        :id="id"
        :model-value="draft?.text ?? jsonText(modelValue)"
        mono
        :rows="4"
        placeholder="JSON"
        :described-by="describedBy"
        :invalid="invalid"
        @update:model-value="onJsonInput"
      />
      <SchemaScalar
        v-else
        :schema="schema"
        :kind="kind"
        :id="id"
        :label="label"
        :model-value="modelValue"
        :described-by="describedBy"
        :invalid="invalid"
        @update:model-value="emit('update:modelValue', $event)"
        @problem="problem = $event"
      />
    </template>
  </SchemaFrame>
</template>
