<script setup lang="ts">
/** 表单项：可见 label、辅助文字、紧贴字段的错误（aria-describedby 关联） */
defineProps<{ id: string; label: string; hint?: string; error?: string; required?: boolean }>()
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <label :for="id" class="text-sm font-medium text-fg">
      {{ label }}<span v-if="required" class="text-danger" aria-hidden="true"> *</span>
    </label>
    <slot :described-by="error ? `${id}-error` : hint ? `${id}-hint` : undefined" :invalid="!!error" />
    <p v-if="error" :id="`${id}-error`" class="text-xs text-danger" role="alert">{{ error }}</p>
    <p v-else-if="hint" :id="`${id}-hint`" class="text-xs text-fg-muted">{{ hint }}</p>
  </div>
</template>
