<script setup lang="ts">
/**
 * 映射（additionalProperties）：一行一个键值对。行在本地存——对象装不下重复或空着的键，
 * 有问题的时候不往外写值、登记路径拦住保存，不然重复的键里总有一个会被悄悄吞掉。
 * 外面换了值（重新加载、保存后刷新）才按新值重建。
 */
import { Plus, X } from 'lucide-vue-next'
import { computed, nextTick, ref, toRaw, watch } from 'vue'
import type { JsonSchema } from '../../api/types.js'
import { asRecord, blankValue, fieldKind, joinPath, mapFromRows, mapValueSchema } from '../../lib/schemaForm.js'
import QInput from '../ui/QInput.vue'
import { useInvalid } from './invalid.js'
import SchemaField from './SchemaField.vue'

const props = defineProps<{ schema: JsonSchema; modelValue: unknown; path: string; id: string; label: string; errors?: Record<string, string> }>()
const emit = defineEmits<{ 'update:modelValue': [value: Record<string, unknown>] }>()

interface Row {
  id: number
  key: string
  value: unknown
  seed?: unknown
}
let seq = 0
const toRows = (v: unknown): Row[] => Object.entries(asRecord(v)).map(([key, value]) => ({ id: ++seq, key, value }))

const rows = ref<Row[]>(toRows(props.modelValue))
let sent: unknown = toRaw(props.modelValue)
watch(
  () => props.modelValue,
  (v) => {
    if (toRaw(v) === sent) return
    sent = toRaw(v)
    rows.value = toRows(v)
  },
)

const result = computed(() => mapFromRows(rows.value.map((r) => ({ key: r.key, value: toRaw(r.value), seed: r.seed }))))
const problems = computed(() => new Map(result.value.problems.map((p) => [p.row, p.message])))
useInvalid(() => result.value.problems.map((p) => (p.key ? joinPath(props.path, p.key) : props.path)))

function sync() {
  if (result.value.problems.length) return
  sent = result.value.value
  emit('update:modelValue', result.value.value)
}

const valueSchema = (r: Row) => mapValueSchema(props.schema, r.value)
const rowId = (r: Row) => `${props.id}-r${r.id}`
/** 值是单个输入框时和键并排放；是一组（对象、列表、多行）时放到键下面，整行套一张卡片 */
const inline = (r: Row) => ['string', 'number', 'boolean', 'enum', 'const', 'secret'].includes(fieldKind(valueSchema(r)))

async function add() {
  const seed = blankValue(mapValueSchema(props.schema, undefined))
  const row: Row = { id: ++seq, key: '', value: seed, seed }
  rows.value.push(row)
  await nextTick()
  document.getElementById(`${rowId(row)}-key`)?.focus()
}
function remove(i: number) {
  rows.value.splice(i, 1)
  sync()
}
function update(r: Row, patch: Partial<Pick<Row, 'key' | 'value'>>) {
  Object.assign(r, patch)
  sync()
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <TransitionGroup name="list" tag="div" class="flex flex-col gap-2">
      <div v-for="(r, i) in rows" :key="r.id" class="flex flex-col gap-1" :class="!inline(r) && 'rounded-md border border-border bg-surface p-3'">
        <div class="flex items-start gap-1.5">
          <div class="grid min-w-0 flex-1 grid-cols-1 gap-1.5" :class="inline(r) && 'sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]'">
            <QInput
              :id="`${rowId(r)}-key`"
              :model-value="r.key"
              placeholder="键"
              :aria-label="`${label} 第 ${i + 1} 项的键`"
              :invalid="problems.has(i)"
              :described-by="problems.has(i) ? `${rowId(r)}-problem` : undefined"
              @update:model-value="update(r, { key: $event })"
            />
            <SchemaField
              bare
              :schema="valueSchema(r)"
              :model-value="r.value"
              :path="r.key.trim() ? joinPath(path, r.key.trim()) : path"
              :id="rowId(r)"
              :label="`${r.key.trim() || `第 ${i + 1} 项`} 的值`"
              :errors="errors"
              @update:model-value="update(r, { value: $event })"
            />
          </div>
          <button
            type="button"
            class="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-fg-subtle transition-colors duration-(--qb-duration) hover:bg-danger-bg hover:text-danger"
            :aria-label="`删除第 ${i + 1} 项`"
            @click="remove(i)"
          >
            <X class="size-3.5" aria-hidden="true" />
          </button>
        </div>
        <p v-if="problems.has(i)" :id="`${rowId(r)}-problem`" class="text-xs text-danger" role="alert">{{ problems.get(i) }}</p>
      </div>
    </TransitionGroup>
    <p v-if="!rows.length" class="text-xs text-fg-subtle">还没有，点下面添加。</p>
    <div>
      <button
        type="button"
        class="inline-flex h-7 cursor-pointer items-center gap-1 rounded-full px-2.5 text-xs font-medium text-fg-muted transition-colors duration-(--qb-duration) hover:bg-surface-muted hover:text-fg"
        @click="add"
      >
        <Plus class="size-3.5" aria-hidden="true" />添加一项
      </button>
    </div>
  </div>
</template>
