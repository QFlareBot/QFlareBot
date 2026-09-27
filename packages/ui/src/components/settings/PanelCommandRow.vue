<script setup lang="ts">
/** 面板里的一条指令：默认只占一行，点名称或展开才改名称与描述 */
import { ChevronDown } from 'lucide-vue-next'
import { computed } from 'vue'
import { DESC_MAX, displayWidth, NAME_MAX, type PanelDraftItem } from '../../lib/qqPanel.js'
import QBadge from '../ui/QBadge.vue'
import QInput from '../ui/QInput.vue'

const props = defineProps<{ item: PanelDraftItem; index: number; open: boolean }>()
const emit = defineEmits<{ toggle: [open: boolean]; touch: [] }>()

const nameInvalid = computed(() => props.item.selected && (!props.item.name.trim() || displayWidth(props.item.name) > NAME_MAX))
const descInvalid = computed(() => props.item.selected && (!props.item.desc.trim() || displayWidth(props.item.desc) > DESC_MAX))
</script>

<template>
  <li class="px-4 py-2.5 transition-colors duration-(--qb-duration) hover:bg-surface-muted/50">
    <div class="flex items-center gap-2.5">
      <input
        v-model="item.selected"
        type="checkbox"
        :disabled="item.tooWide"
        :aria-label="`选中指令 ${item.name}`"
        @change="emit('touch')"
      />
      <button type="button" class="flex min-w-0 flex-1 items-center gap-2 text-left" :aria-expanded="open" @click="emit('toggle', !open)">
        <span class="shrink-0 font-mono text-sm text-fg">{{ item.name || '（无名称）' }}</span>
        <span class="min-w-0 flex-1 truncate text-xs text-fg-muted">{{ item.desc }}</span>
        <QBadge v-if="item.isNew" tone="accent">新</QBadge>
        <QBadge v-if="item.onlyAdmin" tone="warning">仅管理员</QBadge>
        <QBadge v-if="item.tooWide" tone="danger">放不下</QBadge>
        <ChevronDown class="size-3.5 shrink-0 text-fg-subtle transition-transform duration-(--qb-duration-slow)" :class="open && 'rotate-180'" aria-hidden="true" />
      </button>
    </div>

    <div v-if="open" class="mt-3 grid gap-3 pl-6 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <div>
        <QInput v-model="item.name" :invalid="nameInvalid" :aria-label="`指令名称 ${index + 1}`" @update:model-value="emit('touch')" />
        <p class="mt-1 text-xs" :class="displayWidth(item.name) > NAME_MAX ? 'text-danger' : 'text-fg-subtle'">
          <template v-if="item.tooWide">命令名和别名都太长，放不进面板；名称要和命令对得上，不能截断</template>
          <template v-else>名称宽度 {{ displayWidth(item.name) }}/{{ NAME_MAX }}</template>
        </p>
      </div>
      <div>
        <QInput v-model="item.desc" :invalid="descInvalid" :aria-label="`指令描述 ${index + 1}`" @update:model-value="emit('touch')" />
        <p class="mt-1 text-xs" :class="displayWidth(item.desc) > DESC_MAX ? 'text-danger' : 'text-fg-subtle'">描述宽度 {{ displayWidth(item.desc) }}/{{ DESC_MAX }}</p>
      </div>
    </div>
  </li>
</template>
