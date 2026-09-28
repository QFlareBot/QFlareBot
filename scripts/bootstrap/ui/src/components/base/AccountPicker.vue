<script setup lang="ts">
/** Token 能访问好几个账户时选一个；选中即重新验证 */
import type { Account } from '../../types.js'

defineProps<{ accounts: Account[] }>()
const model = defineModel<string>({ required: true })
</script>

<template>
  <fieldset>
    <legend class="text-sm font-medium text-fg">部署到哪个账户</legend>
    <!-- 列宽钉成 minmax(0, 1fr)：隐式列会按不换行的长账户 ID 撑宽，手机上溢出卡片 -->
    <div class="mt-2 grid grid-cols-1 gap-1.5">
      <label
        v-for="a in accounts"
        :key="a.id"
        class="flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2.5 transition-[background-color,border-color] duration-(--qb-duration)"
        :class="model === a.id ? 'border-accent/50 bg-primary/50' : 'border-border hover:bg-surface-muted'"
      >
        <input v-model="model" type="radio" name="account" :value="a.id" class="size-4 shrink-0 cursor-pointer" />
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm text-fg">{{ a.name }}</span>
          <span class="block truncate font-mono text-xs text-fg-subtle">{{ a.id }}</span>
        </span>
      </label>
    </div>
  </fieldset>
</template>
