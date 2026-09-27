<script setup lang="ts">
/** 全局唯一的确认对话框，由 useConfirm() 驱动 */
import { CircleHelp, TriangleAlert } from 'lucide-vue-next'
import { computed, ref, watch } from 'vue'
import { useConfirmHost, type ConfirmOptions } from '../composables/useConfirm.js'
import QButton from './ui/QButton.vue'
import QDialog from './ui/QDialog.vue'

const { pending, settle } = useConfirmHost()
const open = computed(() => !!pending.value)
/** 关的时候留着上一份内容，淡出期间文字不会先消失 */
const view = ref<ConfirmOptions>({ title: '' })
const checked = ref(false)

watch(pending, (p) => {
  if (!p) return
  view.value = p
  checked.value = false
})
</script>

<template>
  <QDialog :open="open" role="alertdialog" labelledby="qb-confirm-title" describedby="qb-confirm-message" @close="settle(null)">
    <div class="flex gap-3.5">
      <span
        class="flex size-9 shrink-0 items-center justify-center rounded-md"
        :class="view.danger ? 'bg-danger-bg text-danger' : 'bg-surface-muted text-fg-muted'"
        aria-hidden="true"
      >
        <TriangleAlert v-if="view.danger" class="size-4.5" />
        <CircleHelp v-else class="size-4.5" />
      </span>
      <div class="min-w-0 flex-1 pt-1">
        <h2 id="qb-confirm-title" class="text-base font-semibold text-balance text-fg">{{ view.title }}</h2>
        <p v-if="view.message" id="qb-confirm-message" class="mt-1.5 text-sm whitespace-pre-line text-pretty text-fg-muted">{{ view.message }}</p>
      </div>
    </div>
    <p v-if="view.warning" class="mt-4 rounded-md bg-warning-bg px-3 py-2 text-xs text-warning">{{ view.warning }}</p>
    <label
      v-if="view.checkbox"
      class="mt-4 flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5 transition-colors duration-(--qb-duration)"
      :class="checked ? 'border-danger/40 bg-danger-bg' : 'border-border'"
    >
      <input v-model="checked" type="checkbox" class="mt-0.5 size-4 shrink-0" :class="view.danger && 'accent-(--qb-danger)'" />
      <span class="text-sm text-fg">
        {{ view.checkbox.label }}
        <span v-if="view.checkbox.hint" class="mt-0.5 block text-xs text-fg-muted">{{ view.checkbox.hint }}</span>
      </span>
    </label>
    <div class="mt-5 flex flex-wrap justify-end gap-2">
      <!-- 危险操作默认聚焦「取消」，回车不会误删 -->
      <QButton :data-autofocus="view.danger || undefined" @click="settle(null)">{{ view.cancelText ?? '取消' }}</QButton>
      <QButton :variant="view.danger ? 'destructive' : 'primary'" :data-autofocus="!view.danger || undefined" @click="settle({ checked })">
        {{ view.confirmText ?? '确定' }}
      </QButton>
    </div>
  </QDialog>
</template>
