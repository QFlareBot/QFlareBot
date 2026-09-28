<script setup lang="ts">
/**
 * 对象数组：一项一张卡片，可上下移、删除，末尾「添加一项」。
 * 每项配一个本地 key 跟着值一起移动：拿下标当 key 的话，上移之后卡片里的 JSON 草稿、焦点会留在原位置。
 */
import { ChevronDown, ChevronUp, Plus, X } from 'lucide-vue-next'
import { computed, nextTick, ref, toRaw, watch } from 'vue'
import type { JsonSchema } from '../../api/types.js'
import { asRecord, blankValue, getOwn, joinId, joinPath, moveItem, removeAt, setIn } from '../../lib/schemaForm.js'
import SchemaField from './SchemaField.vue'

const props = defineProps<{ schema: JsonSchema; modelValue: unknown; path: string; id: string; label: string; errors?: Record<string, string> }>()
const emit = defineEmits<{ 'update:modelValue': [value: unknown[]] }>()

const itemSchema = computed<JsonSchema>(() => props.schema.items ?? {})
const items = computed(() => (Array.isArray(props.modelValue) ? (props.modelValue as unknown[]) : []))
const raw = () => toRaw(items.value)

let seq = 0
const keys = ref<number[]>(items.value.map(() => ++seq))
// 外面换了值、长度对不上才重建；自己增删移动时 keys 已经同步改好了
watch(
  () => items.value.length,
  (n) => {
    if (n !== keys.value.length) keys.value = Array.from({ length: n }, () => ++seq)
  },
)

function commit(next: unknown[], nextKeys: number[]) {
  keys.value = nextKeys
  emit('update:modelValue', next)
}
const add = () => commit([...raw(), blankValue(itemSchema.value)], [...keys.value, ++seq])
const remove = (i: number) => commit(removeAt(raw(), i), removeAt(keys.value, i))
const setItem = (i: number, v: unknown) => emit('update:modelValue', setIn(raw(), [i], v) as unknown[])

const root = ref<HTMLElement | null>(null)
async function move(i: number, to: number) {
  const key = keys.value[i]
  commit(moveItem(raw(), i, to), moveItem(keys.value, i, to))
  // 卡片挪了位置，焦点跟着同一张卡片；挪到头、这个方向的按钮禁用了就落到另一个上
  await nextTick()
  const card = root.value?.querySelector(`[data-key="${key}"]`)
  const dir = to < i ? 'up' : 'down'
  const btn = card?.querySelector<HTMLButtonElement>(`[data-move="${dir}"]:not(:disabled)`) ?? card?.querySelector<HTMLButtonElement>('[data-move]:not(:disabled)')
  btn?.focus()
}

/** 卡片标题后面带上第一个文本字段的值，列表长了好认 */
function summary(item: unknown): string {
  for (const [key, s] of Object.entries(itemSchema.value.properties ?? {})) {
    const v = getOwn(asRecord(item), key)
    if (s.type === 'string' && !s.writeOnly && typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

const iconBtn =
  'flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-fg-subtle transition-colors duration-(--qb-duration) disabled:pointer-events-none disabled:opacity-30'
</script>

<template>
  <div ref="root" class="flex flex-col gap-2">
    <TransitionGroup name="list" tag="div" class="flex flex-col gap-2">
      <div v-for="(item, i) in items" :key="keys[i] ?? `i${i}`" :data-key="keys[i]" class="rounded-md border border-border bg-surface p-3">
        <div class="-mt-1.5 -mr-1.5 mb-2 flex items-center gap-0.5">
          <p class="min-w-0 flex-1 truncate text-xs font-medium text-fg-muted" aria-hidden="true">
            第 {{ i + 1 }} 项<span v-if="summary(item)" class="font-normal text-fg-subtle"> · {{ summary(item) }}</span>
          </p>
          <button type="button" data-move="up" :class="[iconBtn, 'hover:bg-surface-muted hover:text-fg']" :disabled="i === 0" :aria-label="`上移第 ${i + 1} 项`" @click="move(i, i - 1)">
            <ChevronUp class="size-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            data-move="down"
            :class="[iconBtn, 'hover:bg-surface-muted hover:text-fg']"
            :disabled="i === items.length - 1"
            :aria-label="`下移第 ${i + 1} 项`"
            @click="move(i, i + 1)"
          >
            <ChevronDown class="size-4" aria-hidden="true" />
          </button>
          <button type="button" :class="[iconBtn, 'hover:bg-danger-bg hover:text-danger']" :aria-label="`删除第 ${i + 1} 项`" @click="remove(i)">
            <X class="size-3.5" aria-hidden="true" />
          </button>
        </div>
        <SchemaField
          bare
          :schema="itemSchema"
          :model-value="item"
          :path="joinPath(path, i)"
          :id="joinId(id, i)"
          :label="`${label} 第 ${i + 1} 项`"
          :errors="errors"
          @update:model-value="setItem(i, $event)"
        />
      </div>
    </TransitionGroup>
    <p v-if="!items.length" class="text-xs text-fg-subtle">还没有，点下面添加。</p>
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
