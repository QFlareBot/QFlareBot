<script setup lang="ts">
/** 仍是原生 select（键盘、手机滚轮选择器都照旧），只换掉浏览器自带的箭头 */
import { ChevronDown } from 'lucide-vue-next'
import { computed, useAttrs } from 'vue'

defineOptions({ inheritAttrs: false })
defineProps<{ modelValue: string; options: Array<{ value: string; label: string }>; id?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

// class 给外层（控制宽度），其余属性（aria-*、disabled…）给 select 本身
const attrs = useAttrs()
const rest = computed(() => {
  const { class: _class, ...others } = attrs
  return others
})
</script>

<template>
  <div class="relative" :class="attrs.class as string">
    <select
      v-bind="rest"
      :id="id"
      :value="modelValue"
      class="qb-control h-8 w-full cursor-pointer appearance-none pr-8 pl-3 text-sm"
      @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
    >
      <option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option>
    </select>
    <ChevronDown class="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-fg-muted" aria-hidden="true" />
  </div>
</template>
