<script setup lang="ts">
/** 面板指令按插件分组：每组默认折叠，只显示「已选 n/m」；搜索时自动展开命中的组 */
import { ChevronDown, Search } from 'lucide-vue-next'
import { computed, ref, watch } from 'vue'
import { ITEMS_MAX, type PanelDraftItem } from '../../lib/qqPanel.js'
import QInput from '../ui/QInput.vue'
import PanelCommandRow from './PanelCommandRow.vue'

const props = defineProps<{ items: PanelDraftItem[] }>()
const emit = defineEmits<{ touch: [] }>()

const query = ref('')
/** 展开的插件分组：默认都收起，插件多了页面才不会变得很长 */
const expanded = ref(new Set<string>())
const openRows = ref(new Set<string>())

interface Group {
  id: string
  label: string
  items: PanelDraftItem[]
  selected: number
  /** 组里有没有这条命令（用于搜索后自动展开） */
  match: boolean
}

const groups = computed<Group[]>(() => {
  const q = query.value.trim().toLowerCase()
  const map = new Map<string, Group>()
  for (const item of props.items) {
    const id = item.key.split('/')[0] ?? item.plugin
    const g = map.get(id) ?? { id, label: item.plugin, items: [], selected: 0, match: false }
    const hit = !q || [item.name, item.desc, item.plugin, id].some((s) => s.toLowerCase().includes(q))
    g.items.push(item)
    if (item.selected) g.selected += 1
    if (hit) g.match = true
    map.set(id, g)
  }
  return [...map.values()].filter((g) => g.match)
})

// 搜索时展开命中的组，方便直接勾
watch(query, (q) => {
  if (q.trim()) expanded.value = new Set(groups.value.map((g) => g.id))
})

const totalSelected = computed(() => props.items.filter((i) => i.selected).length)
const overLimit = computed(() => totalSelected.value > ITEMS_MAX)

function toggleGroup(id: string) {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

/** 组头的勾选框：全选 / 全不选；已经全选就取消 */
function toggleAll(g: Group) {
  const on = g.selected < g.items.filter((i) => !i.tooWide).length
  for (const i of g.items) if (!i.tooWide) i.selected = on
  emit('touch')
}

function toggleRow(key: string, open: boolean) {
  const next = new Set(openRows.value)
  if (open) next.add(key)
  else next.delete(key)
  openRows.value = next
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex flex-wrap items-center gap-3">
      <div class="relative min-w-0 flex-1 basis-52">
        <Search class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
        <QInput v-model="query" class="pl-8" placeholder="搜索命令" aria-label="搜索命令" />
      </div>
      <p class="text-xs text-fg-muted">
        已选 <span class="tabular-nums" :class="overLimit ? 'text-danger' : 'text-fg'">{{ totalSelected }}/{{ ITEMS_MAX }}</span> 项
      </p>
    </div>

    <p v-if="!groups.length" class="py-6 text-center text-sm text-fg-muted">
      {{ items.length ? '没有匹配的命令。' : '已启用的插件里没有命令。' }}
    </p>
    <ul v-else class="flex flex-col gap-2">
      <li v-for="g in groups" :key="g.id" class="overflow-hidden rounded-lg border border-border">
        <div class="flex items-center gap-2.5 bg-surface-muted/50 px-4 py-2.5">
          <input
            type="checkbox"
            :checked="!!g.selected && g.selected >= g.items.filter((i) => !i.tooWide).length"
            :indeterminate.prop="g.selected > 0 && g.selected < g.items.filter((i) => !i.tooWide).length"
            :aria-label="`全选 ${g.label} 的命令`"
            @change="toggleAll(g)"
          />
          <button type="button" class="flex min-w-0 flex-1 items-center gap-2 text-left" :aria-expanded="expanded.has(g.id)" @click="toggleGroup(g.id)">
            <span class="truncate text-sm font-medium text-fg">{{ g.label }}</span>
            <span class="shrink-0 text-xs text-fg-subtle tabular-nums">已选 {{ g.selected }}/{{ g.items.length }}</span>
            <ChevronDown class="ml-auto size-4 shrink-0 text-fg-subtle transition-transform duration-(--qb-duration-slow)" :class="expanded.has(g.id) && 'rotate-180'" aria-hidden="true" />
          </button>
        </div>
        <ul v-if="expanded.has(g.id)" class="divide-y divide-border border-t border-border">
          <PanelCommandRow
            v-for="(item, i) in g.items"
            :key="item.key"
            :item="item"
            :index="i"
            :open="openRows.has(item.key)"
            @toggle="toggleRow(item.key, $event)"
            @touch="emit('touch')"
          />
        </ul>
      </li>
    </ul>
  </div>
</template>
