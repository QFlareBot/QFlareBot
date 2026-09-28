<script setup lang="ts">
/**
 * 密钥（writeOnly 字符串）。运行时发来的是占位（SECRET_PLACEHOLDER_PREFIX 开头），真值不出服务器：
 * 占位原样传回表示「不动」，空字符串表示「清掉」。所以占位绝不能出现在输入框里——
 * 显示「已设置」，要改就换成空的密码框；改到一半反悔可以撤回到原来的占位。
 */
import { Eye, EyeOff, KeyRound } from 'lucide-vue-next'
import { computed, nextTick, ref, watch } from 'vue'
import { isSecretPlaceholder } from '../../lib/schemaForm.js'
import QButton from '../ui/QButton.vue'
import QInput from '../ui/QInput.vue'

const props = defineProps<{ modelValue: unknown; id: string; label: string; describedBy?: string; invalid?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: unknown] }>()

/** 服务器上已有值时它的占位；清除、更换之后靠它撤回 */
const saved = ref<string | null>(isSecretPlaceholder(props.modelValue) ? props.modelValue : null)
const editing = ref(false)
const revealed = ref(false)

let sent: unknown
function send(v: unknown) {
  sent = v
  emit('update:modelValue', v)
}

// 外面换来的占位（重新加载、保存后刷新）才回到「已设置」；自己还原出去的占位不算，不然删到空框就被踢出编辑
watch(
  () => props.modelValue,
  (v) => {
    if (!isSecretPlaceholder(v) || v === sent) return
    saved.value = v
    editing.value = false
  },
)

const isSet = computed(() => isSecretPlaceholder(props.modelValue) && !editing.value)
const text = computed(() => (typeof props.modelValue === 'string' && !isSecretPlaceholder(props.modelValue) ? props.modelValue : ''))
const note = computed(() => {
  if (!saved.value) return '留空表示不设置'
  if (text.value) return '保存后替换原来的值'
  return editing.value ? '留空则保留原来的值' : '已清除，保存后生效'
})

async function replace() {
  editing.value = true
  await nextTick()
  document.getElementById(props.id)?.focus()
}
function onInput(v: string) {
  // 「更换」时删空输入框不等于清除：还原成占位；要清除用「清除」
  send(v === '' && editing.value && saved.value ? saved.value : v)
}
function clear() {
  editing.value = false
  send('')
}
function undo() {
  editing.value = false
  revealed.value = false
  send(saved.value)
}
</script>

<template>
  <div v-if="isSet" role="group" :aria-label="label" :aria-describedby="describedBy" class="flex flex-wrap items-center gap-2">
    <span class="inline-flex h-8 items-center gap-1.5 rounded-md bg-surface-muted px-3 text-sm text-fg-muted">
      <KeyRound class="size-3.5" aria-hidden="true" />已设置
    </span>
    <QButton size="sm" :aria-label="`更换${label}`" @click="replace">更换</QButton>
    <QButton size="sm" variant="ghost" :aria-label="`清除${label}`" @click="clear">清除</QButton>
  </div>
  <div v-else class="flex flex-col gap-1.5">
    <div class="flex items-center gap-1.5">
      <QInput
        :id="id"
        class="min-w-0"
        :type="revealed ? 'text' : 'password'"
        :model-value="text"
        autocomplete="new-password"
        spellcheck="false"
        :described-by="[describedBy, `${id}-secret`].filter(Boolean).join(' ')"
        :invalid="invalid"
        @update:model-value="onInput"
      />
      <button
        type="button"
        class="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-fg-subtle transition-colors duration-(--qb-duration) hover:bg-surface-muted hover:text-fg"
        :aria-label="revealed ? `隐藏${label}` : `显示${label}`"
        :aria-pressed="revealed"
        @click="revealed = !revealed"
      >
        <EyeOff v-if="revealed" class="size-4" aria-hidden="true" />
        <Eye v-else class="size-4" aria-hidden="true" />
      </button>
    </div>
    <p :id="`${id}-secret`" class="flex flex-wrap items-center gap-x-2 text-xs text-fg-muted">
      <span>{{ note }}</span>
      <button v-if="saved" type="button" class="cursor-pointer font-medium underline-offset-2 hover:text-fg hover:underline" @click="undo">
        {{ editing ? '取消更换' : '撤销' }}
      </button>
    </p>
  </div>
</template>
