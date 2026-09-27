<script setup lang="ts">
/** 已装插件列表的一行：开关、名称与状态、检查 / 执行更新，点主体进详情 */
import { ChevronRight } from 'lucide-vue-next'
import { computed } from 'vue'
import type { PluginInfo } from '../../api/types.js'
import type { BuildState } from '../../composables/useBuildState.js'
import type { PluginUpdates } from '../../composables/usePluginUpdates.js'
import QBadge from '../ui/QBadge.vue'
import QButton from '../ui/QButton.vue'
import QSwitch from '../ui/QSwitch.vue'

const props = defineProps<{ plugin: PluginInfo; build: BuildState; updates: PluginUpdates }>()
const emit = defineEmits<{ toggle: [enabled: boolean] }>()

const p = computed(() => props.plugin)
const managed = computed(() => props.build.managedOf(p.value))
const update = computed(() => props.updates.available.value[p.value.name])
const upgradeFailed = computed(() => !!managed.value?.buildError || managed.value?.lastRecord?.status === 'failed')

const summary = computed(() => {
  const x = p.value
  return [
    x.commands.length && `${x.commands.length} 个命令`,
    x.events.length && `${x.events.length} 个事件`,
    x.buttons.length && `${x.buttons.length} 个按键`,
    x.cron.length && `${x.cron.length} 个定时`,
    x.routes.length && `${x.routes.length} 个路由`,
  ]
    .filter(Boolean)
    .join(' · ')
})
</script>

<template>
  <li class="flex items-center gap-2 py-1 pr-3 pl-2 transition-colors duration-(--qb-duration) hover:bg-surface-muted/60">
    <!-- 有插件可更新时才留出勾选的位置，平时开关贴着左边 -->
    <span v-if="Object.keys(updates.available.value).length" class="flex w-6 shrink-0 justify-center">
      <input
        v-if="update"
        type="checkbox"
        :checked="updates.selected.value.has(p.name)"
        :disabled="!!update.newDurableObjects.length || updates.updatingBatch.value"
        :aria-label="`选中 ${p.displayName} 的更新`"
        @change="updates.toggleSelected(p.name, ($event.target as HTMLInputElement).checked)"
      />
    </span>
    <QSwitch :model-value="p.enabled" :label="`${p.enabled ? '禁用' : '启用'} ${p.displayName}`" :disabled="!!p.error" @update:model-value="emit('toggle', $event)" />
    <RouterLink :to="`/plugins/${p.name}`" class="flex min-w-0 flex-1 items-center gap-3 py-2.5">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span class="text-sm font-medium text-fg">{{ p.displayName }}</span>
          <span class="font-mono text-xs text-fg-subtle">{{ p.name }}@{{ p.version }}</span>
          <QBadge v-if="p.error" tone="danger">加载失败</QBadge>
          <QBadge v-else-if="!p.enabled">已禁用</QBadge>
          <QBadge v-if="!p.installed">内置</QBadge>
          <QBadge v-if="p.ui" tone="accent">有页面</QBadge>
          <QBadge v-if="p.removing" tone="warning">卸载待生效</QBadge>
          <QBadge v-else-if="managed?.state === 'differs'" :tone="upgradeFailed ? 'danger' : 'warning'">
            {{ upgradeFailed ? '升级失败' : `待升级到 ${managed.version}` }}
          </QBadge>
          <QBadge v-if="update" tone="warning" class="qb-pop">可更新：{{ updates.updateLabel(p, update) }}</QBadge>
        </div>
        <p class="mt-0.5 truncate text-xs text-fg-muted">{{ p.error ?? p.description ?? summary }}</p>
        <p v-if="update?.newPermissions.length" class="text-xs text-warning">新版本新增权限：{{ update.newPermissions.join('、') }}</p>
        <p v-if="update?.newDurableObjects.length" class="text-xs text-warning">
          新版本新增 Durable Object 类（{{ update.newDurableObjects.join('、') }}），要先往仓库补 migrations，不能批量更新
        </p>
      </div>
      <span class="hidden shrink-0 text-xs text-fg-subtle lg:block">{{ summary }}</span>
    </RouterLink>
    <QButton
      v-if="update"
      size="sm"
      variant="primary"
      :loading="updates.updating.value === p.name"
      :disabled="updates.updatingBatch.value"
      @click="updates.updateOne(p)"
    >
      {{ update.newDurableObjects.length ? '预检升级' : '更新' }}
    </QButton>
    <QButton v-else-if="updates.canCheck(p)" size="sm" variant="ghost" :loading="updates.checking.value === p.name" @click="updates.checkOne(p)">
      {{ updates.checkedLatest.value[p.name] ? '已是最新' : '检查更新' }}
    </QButton>
    <ChevronRight class="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
  </li>
</template>
