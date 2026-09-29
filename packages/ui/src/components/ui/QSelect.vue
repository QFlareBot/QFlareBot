<script setup lang="ts">
/**
 * 下拉选择：按钮 + 自己画的选项浮层，不用原生 select（它弹出的列表是系统样式，跟柔光风格对不上）。
 * 键盘操作在 useListbox，浮层位置在 useAnchoredPanel；浮层挂在 body 上，卡片、对话框的 overflow 裁不到。
 */
import { Check, ChevronDown } from 'lucide-vue-next'
import { computed, nextTick, onBeforeUnmount, ref, useAttrs, useId, watch } from 'vue'
import { useAnchoredPanel } from '../../composables/useAnchoredPanel.js'
import { useListbox } from '../../composables/useListbox.js'

defineOptions({ inheritAttrs: false })
const props = defineProps<{ modelValue: string; options: Array<{ value: string; label: string }>; id?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

// class 给外层（控制宽度），其余属性（aria-*、disabled…）给按钮本身
const attrs = useAttrs()
const rest = computed(() => {
  const { class: _class, ...others } = attrs
  return others
})
const invalid = computed(() => attrs['aria-invalid'] === true || attrs['aria-invalid'] === 'true')

const uid = useId()
const listId = `qb-select-${uid}`
const optId = (i: number) => `${listId}-${i}`

const trigger = ref<HTMLButtonElement | null>(null)
const panel = ref<HTMLElement | null>(null)
const open = ref(false)
const selectedIndex = () => props.options.findIndex((o) => o.value === props.modelValue)
const current = computed(() => props.options[selectedIndex()])

function choose(i: number) {
  const o = props.options[i]
  if (o && o.value !== props.modelValue) emit('update:modelValue', o.value)
  hide()
}
const { active, show, hide, onKeydown } = useListbox({ open, labels: () => props.options.map((o) => o.label), selected: selectedIndex, choose })
const { style, placement } = useAnchoredPanel(trigger, open)

function toggle() {
  if (open.value) return hide()
  // Safari 点按钮不给焦点，这里补上：键盘接着用、点别处能收起
  trigger.value?.focus({ preventScroll: true })
  show()
}

// 点到按钮和浮层以外就收起（Safari 里按钮可能没拿到焦点，光靠 blur 不够）
function onPointerDown(e: PointerEvent) {
  const t = e.target as Node
  if (!trigger.value?.contains(t) && !panel.value?.contains(t)) hide()
}
watch(open, (o) => {
  if (o) document.addEventListener('pointerdown', onPointerDown, true)
  else document.removeEventListener('pointerdown', onPointerDown, true)
})
onBeforeUnmount(() => document.removeEventListener('pointerdown', onPointerDown, true))

// 高亮项滚进浮层可见范围
watch([active, open], async () => {
  if (!open.value) return
  await nextTick()
  panel.value?.querySelector(`#${CSS.escape(optId(active.value))}`)?.scrollIntoView({ block: 'nearest' })
})
</script>

<template>
  <div class="relative" :class="attrs.class as string">
    <button
      ref="trigger"
      v-bind="rest"
      :id="id"
      type="button"
      role="combobox"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="listId"
      :aria-activedescendant="open && active >= 0 ? optId(active) : undefined"
      class="qb-control flex h-8 w-full cursor-pointer items-center pr-8 pl-3 text-left text-sm"
      :class="invalid && 'qb-control--invalid'"
      @click="toggle"
      @keydown="onKeydown"
      @blur="hide"
    >
      <span class="min-w-0 truncate">{{ current?.label ?? '' }}</span>
    </button>
    <ChevronDown
      class="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-fg-muted transition-transform duration-(--qb-duration) ease-(--qb-ease)"
      :class="open && 'rotate-180'"
      aria-hidden="true"
    />
    <Teleport to="body">
      <Transition name="menu">
        <!-- mousedown 不抢焦点：焦点留在按钮上，键盘和 aria-activedescendant 才接得上 -->
        <ul
          v-if="open"
          ref="panel"
          :id="listId"
          role="listbox"
          :data-placement="placement"
          class="qb-menu fixed z-[60] overflow-y-auto overscroll-contain rounded-lg border border-card-border bg-surface p-1 shadow-overlay"
          :style="style"
          @mousedown.prevent
        >
          <li
            v-for="(o, i) in options"
            :id="optId(i)"
            :key="o.value"
            role="option"
            :aria-selected="o.value === modelValue"
            class="flex min-h-10 cursor-pointer items-center gap-2 rounded-md px-2.5 text-sm text-fg sm:min-h-8"
            :class="i === active && 'bg-surface-muted'"
            @pointermove="active = i"
            @click="choose(i)"
          >
            <span class="min-w-0 flex-1 truncate" :class="o.value === modelValue && 'font-medium'">{{ o.label }}</span>
            <Check v-if="o.value === modelValue" class="size-4 shrink-0 text-accent" aria-hidden="true" />
          </li>
        </ul>
      </Transition>
    </Teleport>
  </div>
</template>
