<script setup lang="ts">
/** 密钥输入框：默认遮住，右侧可以切换显示；ok 时边框转绿 */
import { Eye, EyeOff } from 'lucide-vue-next'
import { ref } from 'vue'

defineProps<{
  modelValue: string
  id: string
  placeholder?: string
  autocomplete?: string
  invalid?: boolean
  ok?: boolean
  describedBy?: string
  disabled?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [value: string]; paste: []; enter: [] }>()
const shown = ref(false)
</script>

<template>
  <div class="relative">
    <input
      :id="id"
      :type="shown ? 'text' : 'password'"
      :value="modelValue"
      :placeholder="placeholder"
      :autocomplete="autocomplete ?? 'off'"
      :disabled="disabled"
      :aria-invalid="invalid || undefined"
      :aria-describedby="describedBy"
      spellcheck="false"
      autocapitalize="off"
      class="qb-control h-10 w-full pr-11 pl-3.5 font-mono text-sm"
      :class="[invalid && 'qb-control--invalid', ok && 'qb-control--ok']"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      @paste="emit('paste')"
      @keydown.enter.prevent="emit('enter')"
    />
    <button
      type="button"
      class="absolute inset-y-0 right-0 flex w-11 cursor-pointer items-center justify-center rounded-r-md text-fg-subtle transition-colors duration-(--qb-duration) hover:text-fg"
      :aria-label="shown ? '隐藏' : '显示'"
      :aria-pressed="shown"
      :disabled="disabled"
      @click="shown = !shown"
    >
      <Transition name="swap" type="transition" mode="out-in">
        <EyeOff v-if="shown" key="off" class="size-4" aria-hidden="true" />
        <Eye v-else key="on" class="size-4" aria-hidden="true" />
      </Transition>
    </button>
  </div>
</template>
