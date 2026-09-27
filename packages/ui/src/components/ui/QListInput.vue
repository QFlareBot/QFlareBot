<script setup lang="ts">
/**
 * 逐条输入的列表：每条一个输入框，末尾「添加一条」。
 * 回车新增下一条、空行按退格删掉；一次粘贴多行时自动拆成多条。
 * 对外仍是 string[]，编辑中的空行不会传出去。
 */
import { Plus, X } from 'lucide-vue-next'
import { nextTick, ref, watch } from 'vue'
import { cleanList, sameList, splitList } from '../../lib/listInput.js'
import QInput from './QInput.vue'

const props = withDefaults(
  defineProps<{
    modelValue: string[]
    id?: string
    /** 给每个输入框的无障碍名称，会拼上「第 n 条」 */
    label?: string
    placeholder?: string
    mono?: boolean
    addLabel?: string
    describedBy?: string
    /** 粘贴时怎么拆：line 只按换行；any 连空格、逗号也拆（openid、群 ID） */
    separator?: 'line' | 'any'
  }>(),
  { label: '条目', addLabel: '添加一条', separator: 'line' },
)
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>()

interface Row {
  key: number
  value: string
}
let seq = 0
const toRows = (values: readonly string[]): Row[] => (values.length ? values : ['']).map((value) => ({ key: ++seq, value }))

const rows = ref<Row[]>(toRows(props.modelValue))
const root = ref<HTMLElement | null>(null)

// 外面换了值（重新加载、重置）才重建；自己编辑引起的回流不重建，免得光标跳走
watch(
  () => props.modelValue,
  (v) => {
    if (!sameList(v, cleanList(rows.value.map((r) => r.value)))) rows.value = toRows(v)
  },
)

function sync() {
  emit('update:modelValue', cleanList(rows.value.map((r) => r.value)))
}

async function focusRow(i: number) {
  await nextTick()
  const inputs = root.value?.querySelectorAll<HTMLInputElement>('input')
  const el = inputs?.[Math.max(0, Math.min(i, inputs.length - 1))]
  el?.focus()
  el?.setSelectionRange(el.value.length, el.value.length)
}

function add(after = rows.value.length - 1, values: string[] = ['']) {
  rows.value.splice(after + 1, 0, ...values.map((value) => ({ key: ++seq, value })))
  void focusRow(after + values.length)
  sync()
}

function remove(i: number) {
  if (rows.value.length === 1) rows.value[0]!.value = ''
  else rows.value.splice(i, 1)
  void focusRow(i - 1)
  sync()
}

function onKeydown(e: KeyboardEvent, i: number) {
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault()
    add(i)
  } else if (e.key === 'Backspace' && !rows.value[i]!.value && rows.value.length > 1) {
    e.preventDefault()
    remove(i)
  }
}

function onPaste(e: ClipboardEvent, i: number) {
  const parts = splitList(e.clipboardData?.getData('text') ?? '', props.separator)
  if (parts.length < 2) return
  e.preventDefault()
  const row = rows.value[i]!
  if (!row.value.trim()) {
    row.value = parts[0]!
    add(i, parts.slice(1))
  } else add(i, parts)
}
</script>

<template>
  <div ref="root" class="flex flex-col gap-2">
    <TransitionGroup name="list" tag="div" class="flex flex-col gap-2">
      <div v-for="(r, i) in rows" :key="r.key" class="flex items-center gap-1.5">
        <QInput
          v-model="r.value"
          :id="i === 0 ? id : undefined"
          :mono="mono"
          :placeholder="placeholder"
          :aria-label="`${label} 第 ${i + 1} 条`"
          :described-by="i === 0 ? describedBy : undefined"
          @update:model-value="sync"
          @keydown="onKeydown($event, i)"
          @paste="onPaste($event, i)"
        />
        <button
          type="button"
          class="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-fg-subtle transition-colors duration-(--qb-duration) hover:bg-danger-bg hover:text-danger disabled:pointer-events-none disabled:opacity-0"
          :aria-label="`删除第 ${i + 1} 条`"
          :disabled="rows.length === 1 && !r.value"
          @click="remove(i)"
        >
          <X class="size-3.5" aria-hidden="true" />
        </button>
      </div>
    </TransitionGroup>
    <div>
      <button
        type="button"
        class="inline-flex h-7 cursor-pointer items-center gap-1 rounded-full px-2.5 text-xs font-medium text-fg-muted transition-colors duration-(--qb-duration) hover:bg-surface-muted hover:text-fg"
        @click="add()"
      >
        <Plus class="size-3.5" aria-hidden="true" />{{ addLabel }}
      </button>
    </div>
  </div>
</template>
