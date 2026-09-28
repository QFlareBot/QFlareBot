<script setup lang="ts">
/**
 * 同名服务：几个插件提供同一个服务时，同一时间只有一个在提供。只列有重名的，平时整张卡都不出现。
 * 默认是先装、且启用着的那个；选了就一直用选的——它被禁用时依赖它的插件会报错，不会悄悄换人（运行时 services.ts 同一规则）
 */
import { computed, ref } from 'vue'
import { api } from '../../api/client.js'
import type { ServiceInfo } from '../../api/types.js'
import { useStatus } from '../../composables/useStatus.js'
import { useToast } from '../../composables/useToast.js'
import QCard from '../ui/QCard.vue'
import QSelect from '../ui/QSelect.vue'

const { status, pluginByName, refresh } = useStatus()
const { push } = useToast()
const saving = ref<string | null>(null)

const shared = computed(() => (status.value?.services ?? []).filter((s) => s.providers.length > 1))

function label(name: string): string {
  const p = pluginByName(name)
  const title = p && p.displayName !== name ? `${p.displayName}（${name}）` : name
  return p && !p.enabled ? `${title} · 已禁用` : title
}

/** 没选时在用的那个 */
function fallback(s: ServiceInfo): string {
  return s.providers.find((p) => pluginByName(p)?.enabled !== false) ?? s.providers[0]!
}

function options(s: ServiceInfo) {
  return [{ value: '', label: `默认：${label(fallback(s))}` }, ...s.providers.map((p) => ({ value: p, label: label(p) }))]
}

function activeDisabled(s: ServiceInfo): boolean {
  return !!s.active && pluginByName(s.active)?.enabled === false
}

async function choose(s: ServiceInfo, value: string) {
  const who = value ? label(value) : `默认的 ${label(fallback(s))}`
  saving.value = s.name
  try {
    await api.setServiceProvider(s.name, value || null)
    await refresh()
    push(`服务 ${s.name} 改由 ${who} 提供，本节点立即生效，其他节点最多约 60 秒`, 'success')
  } catch (e) {
    push(`切换失败：${(e as Error).message}`, 'error')
  } finally {
    saving.value = null
  }
}
</script>

<template>
  <QCard v-if="shared.length" title="同名服务" description="几个插件提供同一个服务时，同一时间只有一个在提供。">
    <ul class="divide-y divide-border">
      <li v-for="s in shared" :key="s.name" class="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
        <div class="min-w-0">
          <label :for="`svc-${s.name}`" class="font-mono text-sm text-fg">{{ s.name }}</label>
          <p v-if="activeDisabled(s)" class="mt-0.5 text-xs text-warning">{{ label(s.active!) }}：依赖这个服务的插件调用时会报错</p>
        </div>
        <QSelect
          :id="`svc-${s.name}`"
          :model-value="s.selected ?? ''"
          :options="options(s)"
          :disabled="saving === s.name"
          class="w-full sm:w-72"
          @update:model-value="choose(s, $event)"
        />
      </li>
    </ul>
  </QCard>
</template>
