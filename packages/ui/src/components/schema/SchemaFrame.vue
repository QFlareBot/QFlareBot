<script setup lang="ts">
/**
 * 字段外壳：标签、说明、错误。单个控件的说明放在控件下面；一组控件（对象、卡片列表、映射、多选）
 * 的说明放在标签下面，对象再套一层淡底框。
 * 分组用 div + role=group 而不是 fieldset：legend 会骑在边框线上，柔光风格里太硬。
 * 标签右边：改过还没保存时一个小圆点，和出厂默认不一样时「恢复默认」。说明支持行内 Markdown（链接、代码）。
 */
import { RotateCcw } from 'lucide-vue-next'
import { computed } from 'vue'
import QInlineText from '../ui/QInlineText.vue'

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
  /** 改过、还没保存 */
  modified?: boolean
  /** 和出厂默认不一样，可以恢复 */
  resettable?: boolean
}>()
const emit = defineEmits<{ reset: [] }>()

const describedBy = computed(() => (props.error ? `${props.id}-error` : props.hint && !props.bare ? `${props.id}-hint` : undefined))
</script>

<template>
  <div v-if="group" role="group" :aria-labelledby="`${id}-label`" :aria-describedby="describedBy">
    <div class="flex flex-col gap-3" :class="boxed && !bare && 'rounded-md border border-border bg-surface-muted/40 p-3'">
      <div class="flex flex-col gap-0.5" :class="bare && 'sr-only'">
        <div class="flex min-h-6 items-center gap-2">
          <span :id="`${id}-label`" class="text-sm font-medium text-fg">
            {{ label }}<span v-if="required" class="text-danger" aria-hidden="true"> *</span>
          </span>
          <span v-if="modified" class="qb-pop size-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />
          <span v-if="modified" class="sr-only">（已修改，未保存）</span>
          <button
            v-if="resettable && !bare"
            type="button"
            class="ml-auto inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-full px-2 text-xs text-fg-muted transition-colors duration-(--qb-duration) hover:bg-surface-muted hover:text-fg"
            :aria-label="`${label}：恢复默认`"
            @click="emit('reset')"
          >
            <RotateCcw class="size-3" aria-hidden="true" />恢复默认
          </button>
        </div>
        <span v-if="hint && !error" :id="`${id}-hint`" class="text-xs text-pretty text-fg-muted"><QInlineText :text="hint" /></span>
      </div>
      <slot />
    </div>
    <p v-if="error" :id="`${id}-error`" class="mt-1.5 text-xs text-danger" role="alert">{{ error }}</p>
  </div>

  <div v-else class="flex flex-col gap-1.5">
    <div v-if="!bare" class="flex min-h-6 items-center gap-2">
      <label :for="id" class="text-sm font-medium text-fg">
        {{ label }}<span v-if="required" class="text-danger" aria-hidden="true"> *</span>
      </label>
      <span v-if="modified" class="qb-pop size-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />
      <span v-if="modified" class="sr-only">（已修改，未保存）</span>
      <button
        v-if="resettable"
        type="button"
        class="ml-auto inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-full px-2 text-xs text-fg-muted transition-colors duration-(--qb-duration) hover:bg-surface-muted hover:text-fg"
        :aria-label="`${label}：恢复默认`"
        @click="emit('reset')"
      >
        <RotateCcw class="size-3" aria-hidden="true" />恢复默认
      </button>
    </div>
    <label v-else :for="id" class="sr-only">{{ label }}</label>
    <slot :described-by="describedBy" :invalid="!!error" />
    <p v-if="error" :id="`${id}-error`" class="text-xs text-danger" role="alert">{{ error }}</p>
    <p v-else-if="hint && !bare" :id="`${id}-hint`" class="text-xs text-pretty text-fg-muted"><QInlineText :text="hint" /></p>
  </div>
</template>
