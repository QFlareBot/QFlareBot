<script setup lang="ts">
/**
 * 单个值的输入控件：下拉（enum / 全是 const 的 oneOf）、文本、多行文本、数字、开关、字符串列表。
 * 外壳（标签、错误）在 SchemaFrame，这里只管把值读出来、写回去。
 * 数字框里还不合格的内容（不是数字、超出范围）不写回，通过 problem 交给 SchemaField 报错、拦住保存。
 */
import { computed } from 'vue'
import type { JsonSchema } from '../../api/types.js'
import { constChoices, enumIndex, enumOptions, enumValueAt, type FieldKind } from '../../lib/schemaForm.js'
import QInput from '../ui/QInput.vue'
import QListInput from '../ui/QListInput.vue'
import QNumberInput from '../ui/QNumberInput.vue'
import QSelect from '../ui/QSelect.vue'
import QSwitch from '../ui/QSwitch.vue'
import QTextarea from '../ui/QTextarea.vue'

const props = defineProps<{
  schema: JsonSchema
  kind: FieldKind
  modelValue: unknown
  id: string
  label: string
  describedBy?: string
  invalid?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [value: unknown]; problem: [message: string] }>()

// enum 与 const 下拉是一回事：按下标选、写回原值，只是标签来源不同
const choices = computed(() => {
  if (props.kind === 'enum') return { values: props.schema.enum ?? [], options: enumOptions(props.schema.enum ?? []) }
  const c = constChoices(props.schema)
  return c && { values: c.values, options: c.labels.map((label, i) => ({ value: String(i), label })) }
})
const current = computed(() => props.modelValue ?? props.schema.default)

function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v)
}
function list(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : []
}
</script>

<template>
  <QSelect
    v-if="choices"
    :id="id"
    :model-value="String(enumIndex(choices.values, current))"
    :options="choices.options"
    :aria-describedby="describedBy"
    :aria-invalid="invalid || undefined"
    @update:model-value="emit('update:modelValue', enumValueAt(choices.values, $event))"
  />
  <QTextarea
    v-else-if="kind === 'textarea'"
    :id="id"
    :model-value="str(modelValue)"
    :rows="4"
    :placeholder="str(schema.default)"
    :described-by="describedBy"
    :invalid="invalid"
    :maxlength="schema.maxLength"
    @update:model-value="emit('update:modelValue', $event)"
  />
  <QInput
    v-else-if="kind === 'string'"
    :id="id"
    :model-value="str(modelValue)"
    :placeholder="str(schema.default)"
    :described-by="describedBy"
    :invalid="invalid"
    :maxlength="schema.maxLength"
    @update:model-value="emit('update:modelValue', $event)"
  />
  <QNumberInput
    v-else-if="kind === 'number'"
    :id="id"
    class="sm:max-w-48"
    :model-value="typeof modelValue === 'number' ? modelValue : undefined"
    :fallback="typeof schema.default === 'number' ? schema.default : undefined"
    :label="label"
    :described-by="describedBy"
    :invalid="invalid"
    :min="schema.minimum"
    :max="schema.maximum"
    :integer="schema.type === 'integer'"
    @update:model-value="emit('update:modelValue', $event)"
    @problem="emit('problem', $event)"
  />
  <div v-else-if="kind === 'boolean'" class="-ml-3 flex items-center gap-1">
    <QSwitch :model-value="!!current" :label="label" @update:model-value="emit('update:modelValue', $event)" />
    <span class="text-sm text-fg-muted">{{ current ? '开' : '关' }}</span>
  </div>
  <QListInput
    v-else-if="kind === 'string[]'"
    :id="id"
    :model-value="list(modelValue)"
    :label="label"
    :described-by="describedBy"
    @update:model-value="emit('update:modelValue', $event)"
  />
</template>
