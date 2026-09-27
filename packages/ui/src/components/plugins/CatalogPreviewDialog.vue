<script setup lang="ts">
/** 市场批量安装的预检结果：就地弹出，确认后按依赖顺序写进清单、只构建一次 */
import type { PreviewRow } from '../../composables/useCatalogInstall.js'
import QBadge from '../ui/QBadge.vue'
import QButton from '../ui/QButton.vue'
import QDialog from '../ui/QDialog.vue'
import PreviewDetails from './PreviewDetails.vue'

defineProps<{ rows: PreviewRow[] | null; installing: boolean; installableCount: number }>()
const emit = defineEmits<{ cancel: []; confirm: [] }>()
</script>

<template>
  <QDialog :open="!!rows" labelledby="catalog-preview-title" size="lg" @close="!installing && emit('cancel')">
    <h2 id="catalog-preview-title" class="text-base font-semibold text-fg">安装预检</h2>
    <p class="mt-1 text-sm text-fg-muted">确认后按依赖顺序写进插件清单，全部写完只触发一次构建。</p>
    <ul v-if="rows" class="mt-4 flex flex-col gap-3">
      <li v-for="row in rows" :key="row.plugin.name" class="rounded-lg border border-border p-3">
        <div class="mb-1.5 flex flex-wrap items-center gap-2 text-sm">
          <span class="font-medium text-fg">{{ row.plugin.displayName ?? row.plugin.name }}</span>
          <span class="font-mono text-xs text-fg-subtle">{{ row.plugin.name }}@{{ row.preview?.plugin.version ?? row.plugin.version }}</span>
          <QBadge v-if="row.error" tone="danger">装不了</QBadge>
          <QBadge v-else-if="row.waitsForBatch">依赖本批插件</QBadge>
          <QBadge v-else-if="row.preview?.previous">升级自 {{ row.preview.previous.version }}</QBadge>
        </div>
        <p v-if="row.error" class="text-xs break-words whitespace-pre-wrap text-danger">{{ row.error }}</p>
        <p v-else-if="row.waitsForBatch" class="text-xs text-fg-muted">
          它依赖的服务（{{ (row.plugin.depends ?? []).join('、') }}）由这一批里排在前面的插件提供，按顺序写进清单时会通过校验。
        </p>
        <template v-else-if="row.preview">
          <PreviewDetails :preview="row.preview" :notice="row.notice" />
          <label v-if="row.preview.durableObjects" class="mt-2 flex cursor-pointer items-center gap-2 text-xs text-fg">
            <input v-model="row.ackDo" type="checkbox" />
            已往仓库补好 migrations 并推送（不勾就不装它）
          </label>
        </template>
      </li>
    </ul>
    <div class="mt-5 flex flex-wrap justify-end gap-2">
      <QButton :disabled="installing" @click="emit('cancel')">取消</QButton>
      <QButton variant="primary" data-autofocus :loading="installing" :disabled="!installableCount" @click="emit('confirm')">
        确认安装 {{ installableCount }} 个，构建一次
      </QButton>
    </div>
  </QDialog>
</template>
