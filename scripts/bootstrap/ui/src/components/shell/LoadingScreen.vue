<script setup lang="ts">
/** 首次读取 /api/init 时的骨架：和真正的布局同形，读完不跳动；读失败给一个重试 */
import QButton from '@panel/components/ui/QButton.vue'
import { RefreshCw } from 'lucide-vue-next'

defineProps<{ error?: string | null }>()
const emit = defineEmits<{ retry: [] }>()
</script>

<template>
  <div class="mx-auto flex w-full max-w-[1120px] md:gap-8 md:px-6" aria-busy="true">
    <aside class="hidden h-dvh w-[272px] shrink-0 py-6 md:block">
      <div class="qb-glass h-full rounded-[20px] p-5 shadow-card">
        <span class="qb-skeleton block h-8 w-32" />
        <div class="mt-10 space-y-6">
          <div v-for="i in 6" :key="i" class="flex items-center gap-3">
            <span class="qb-skeleton block size-7 rounded-full!" />
            <span class="qb-skeleton block h-3.5 w-28" />
          </div>
        </div>
      </div>
    </aside>
    <main class="min-w-0 flex-1 px-4 pt-8 md:px-0 md:pt-14">
      <div class="mx-auto max-w-[680px]">
        <div class="flex items-start gap-4">
          <span class="qb-skeleton block size-11 rounded-[14px]!" />
          <div class="flex-1 space-y-2 pt-1">
            <span class="qb-skeleton block h-3 w-20" />
            <span class="qb-skeleton block h-6 w-48" />
            <span class="qb-skeleton block h-3.5 w-72 max-w-full" />
          </div>
        </div>
        <div class="mt-8 rounded-lg border border-card-border bg-surface p-6 shadow-card">
          <p v-if="error" class="text-sm text-danger" role="alert">读取向导状态失败：{{ error }}</p>
          <QButton v-if="error" class="mt-4" @click="emit('retry')"><RefreshCw class="size-3.5" aria-hidden="true" />重试</QButton>
          <div v-else class="space-y-3">
            <span class="qb-skeleton block h-4 w-40" />
            <span class="qb-skeleton block h-10 w-full" />
            <span class="qb-skeleton block h-3 w-2/3" />
          </div>
        </div>
      </div>
    </main>
  </div>
</template>
