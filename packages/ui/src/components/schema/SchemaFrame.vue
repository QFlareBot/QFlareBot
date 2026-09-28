<script setup lang="ts">
/**
 * 字段外壳：单个控件走 QField；一组控件（对象、卡片列表、映射）走分组，对象再套一层淡底框。
 * 分组用 div + role=group 而不是 fieldset：legend 会骑在边框线上，柔光风格里太硬。
 */
import { computed } from 'vue'
import QField from '../ui/QField.vue'

const props = defineProps<{
  id: string
  label: string
  hint?: string
  error?: string
  required?: boolean
  group?: boolean
  boxed?: boolean
  /** 不显示标签，只留给读屏（数组卡片里的对象、映射里的值：外面已经有「第 n 项」、键名了） */
  bare?: boolean
}>()

const describedBy = computed(() => (props.error ? `${props.id}-error` : props.hint ? `${props.id}-hint` : undefined))
</script>

<template>
  <div v-if="group" role="group" :aria-labelledby="`${id}-label`" :aria-describedby="describedBy">
    <div class="flex flex-col gap-3" :class="boxed && !bare && 'rounded-md border border-border bg-surface-muted/40 p-3'">
      <div class="flex flex-col gap-0.5" :class="bare && 'sr-only'">
        <span :id="`${id}-label`" class="text-sm font-medium text-fg">
          {{ label }}<span v-if="required" class="text-danger" aria-hidden="true"> *</span>
        </span>
        <span v-if="hint && !error" :id="`${id}-hint`" class="text-xs text-pretty text-fg-muted">{{ hint }}</span>
      </div>
      <slot />
    </div>
    <p v-if="error" :id="`${id}-error`" class="mt-1.5 text-xs text-danger" role="alert">{{ error }}</p>
  </div>

  <div v-else-if="bare" class="flex flex-col gap-1.5">
    <label :for="id" class="sr-only">{{ label }}</label>
    <slot :described-by="describedBy" :invalid="!!error" />
    <p v-if="error" :id="`${id}-error`" class="text-xs text-danger" role="alert">{{ error }}</p>
  </div>

  <QField v-else :id="id" :label="label" :hint="hint" :error="error" :required="required">
    <template #default="slot"><slot v-bind="slot" /></template>
  </QField>
</template>
