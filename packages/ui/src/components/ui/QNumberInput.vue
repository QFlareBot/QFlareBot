<script setup lang="ts">
/**
 * 数字输入：− [文本框] +。文本框不用 type=number（系统箭头、滚轮误改、浏览器气泡），
 * 范围和整数检查交给 lib/numberInput，不合格时不往外写值、通过 problem 告诉外面在字段下报错并拦住保存。
 * 上下方向键加减一步，按住 − / + 连续加减。
 */
import { Minus, Plus } from 'lucide-vue-next'
import { computed, onBeforeUnmount, ref, useAttrs, watch } from 'vue'
import { parseNumber, stepBase, stepNumber, type NumberRules } from '../../lib/numberInput.js'

defineOptions({ inheritAttrs: false })
const props = withDefaults(
  defineProps<{
    modelValue: number | undefined
    id?: string
    min?: number
    max?: number
    integer?: boolean
    step?: number
    /** 空着时按加减从这个数开始（一般是默认值），也当占位显示 */
    fallback?: number
    placeholder?: string
    /** 给 − / + 按钮的无障碍名称：「减小{label}」 */
    label?: string
    describedBy?: string
    invalid?: boolean
    disabled?: boolean
  }>(),
  { step: 1, label: '' },
)
const emit = defineEmits<{ 'update:modelValue': [value: number | undefined]; problem: [message: string] }>()

// class 给外框（控制宽度），其余属性（aria-label…）给文本框
const attrs = useAttrs()
const rest = computed(() => {
  const { class: _class, ...others } = attrs
  return others
})

const rules = computed<NumberRules>(() => ({ min: props.min, max: props.max, integer: props.integer }))
const format = (v: number | undefined) => (v === undefined ? '' : String(v))

const text = ref(format(props.modelValue))
const problem = ref('')
let sent: number | undefined = props.modelValue

function report(message: string) {
  if (message === problem.value) return
  problem.value = message
  emit('problem', message)
}
function send(v: number | undefined) {
  sent = v
  report('')
  if (v !== props.modelValue) emit('update:modelValue', v)
}

// 外面换了值（重新加载、保存后刷新）才覆盖输入框；自己写出去的不覆盖，免得「1.」被改成「1」
watch(
  () => props.modelValue,
  (v) => {
    if (v === sent) return
    sent = v
    text.value = format(v)
    report('')
  },
)

function onInput(t: string) {
  text.value = t
  const parsed = parseNumber(t, rules.value)
  if (parsed.ok) send(parsed.value)
  else report(parsed.error)
}

/** 文本框里是合法数字就从它加减，否则从外面的值、再不然从 fallback */
function current(): number | undefined {
  const parsed = parseNumber(text.value)
  return parsed.ok ? parsed.value : props.modelValue
}
const atMin = computed(() => props.min !== undefined && props.modelValue !== undefined && props.modelValue <= props.min)
const atMax = computed(() => props.max !== undefined && props.modelValue !== undefined && props.modelValue >= props.max)

function bump(dir: 1 | -1): boolean {
  if (props.disabled || (dir < 0 ? atMin.value : atMax.value)) return false
  const from = current() ?? stepBase(props.fallback, rules.value)
  const next = stepNumber(from, dir * props.step, rules.value)
  text.value = format(next)
  send(next)
  return true
}

function onKeydown(e: KeyboardEvent) {
  if (e.isComposing) return
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault()
    bump(e.key === 'ArrowUp' ? 1 : -1)
  }
}

// 按住连续加减：先停一下再加速，松手、移出、取消都停
let timer: ReturnType<typeof setTimeout> | undefined
function stopRepeat() {
  clearTimeout(timer)
  timer = undefined
}
function startRepeat(dir: 1 | -1, e: PointerEvent) {
  if (e.button !== 0) return
  stopRepeat()
  if (!bump(dir)) return
  const tick = (delay: number) => {
    timer = setTimeout(() => {
      if (bump(dir)) tick(Math.max(40, delay * 0.8))
    }, delay)
  }
  tick(400)
}
onBeforeUnmount(stopRepeat)

const inputmode = computed(() => {
  // iOS 的数字键盘没有负号：可能是负数时退回普通键盘
  if (props.min === undefined || props.min < 0) return undefined
  return props.integer ? 'numeric' : 'decimal'
})
const btn =
  'flex w-8 shrink-0 cursor-pointer touch-manipulation items-center select-none justify-center text-fg-muted transition-colors duration-(--qb-duration) hover:bg-surface-muted hover:text-fg active:bg-border disabled:pointer-events-none disabled:opacity-30'
</script>

<template>
  <div
    class="qb-control flex h-8 w-full items-stretch overflow-hidden"
    :class="[attrs.class as string, (invalid || problem) && 'qb-control--invalid', disabled && 'pointer-events-none opacity-50']"
  >
    <!-- 按钮不进 Tab 顺序（键盘用上下键），mousedown 不抢文本框的焦点；读屏点它时 click 的 detail 是 0 -->
    <button
      type="button"
      tabindex="-1"
      :class="btn"
      :disabled="disabled || atMin"
      :aria-label="`减小${label}`"
      @mousedown.prevent
      @contextmenu.prevent
      @pointerdown="startRepeat(-1, $event)"
      @pointerup="stopRepeat"
      @pointerleave="stopRepeat"
      @pointercancel="stopRepeat"
      @click="$event.detail === 0 && bump(-1)"
    >
      <Minus class="size-3.5" aria-hidden="true" />
    </button>
    <input
      v-bind="rest"
      :id="id"
      :value="text"
      type="text"
      role="spinbutton"
      :inputmode="inputmode"
      autocomplete="off"
      spellcheck="false"
      :placeholder="placeholder ?? format(fallback)"
      :disabled="disabled"
      :aria-valuenow="modelValue"
      :aria-valuemin="min"
      :aria-valuemax="max"
      :aria-invalid="invalid || !!problem || undefined"
      :aria-describedby="describedBy"
      class="min-w-0 flex-1 bg-transparent px-1 text-center text-sm tabular-nums outline-none placeholder:text-fg-subtle focus-visible:outline-none"
      @input="onInput(($event.target as HTMLInputElement).value)"
      @keydown="onKeydown"
    />
    <button
      type="button"
      tabindex="-1"
      :class="btn"
      :disabled="disabled || atMax"
      :aria-label="`增大${label}`"
      @mousedown.prevent
      @contextmenu.prevent
      @pointerdown="startRepeat(1, $event)"
      @pointerup="stopRepeat"
      @pointerleave="stopRepeat"
      @pointercancel="stopRepeat"
      @click="$event.detail === 0 && bump(1)"
    >
      <Plus class="size-3.5" aria-hidden="true" />
    </button>
  </div>
</template>
