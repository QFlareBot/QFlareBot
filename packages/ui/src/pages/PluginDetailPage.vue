<script setup lang="ts">
import { ArrowLeft, PanelsTopLeft } from 'lucide-vue-next'
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '../api/client.js'
import PageHeader from '../components/PageHeader.vue'
import SchemaForm from '../components/SchemaForm.vue'
import QBadge from '../components/ui/QBadge.vue'
import QButton from '../components/ui/QButton.vue'
import QCard from '../components/ui/QCard.vue'
import QEmpty from '../components/ui/QEmpty.vue'
import QField from '../components/ui/QField.vue'
import QInput from '../components/ui/QInput.vue'
import QSwitch from '../components/ui/QSwitch.vue'
import QTextarea from '../components/ui/QTextarea.vue'
import { useStatus } from '../composables/useStatus.js'
import { useToast } from '../composables/useToast.js'

const route = useRoute()
const { pluginByName, refresh, status, patchLocal } = useStatus()
const { push } = useToast()

const plugin = computed(() => pluginByName(String(route.params.name)))
const config = ref<Record<string, unknown>>({})
const configText = ref('')
const configError = ref('')
const priority = ref('0')
const saving = ref(false)

watch(
  plugin,
  (p) => {
    if (!p) return
    config.value = { ...((p.config as Record<string, unknown> | null) ?? {}) }
    configText.value = JSON.stringify(p.config ?? {}, null, 2)
    priority.value = String(p.priority)
  },
  { immediate: true },
)

async function toggle(enabled: boolean) {
  if (!plugin.value) return
  patchLocal(plugin.value.name, { enabled })
  try {
    await api.patchPlugin(plugin.value.name, { enabled })
  } catch (e) {
    push(`操作失败：${(e as Error).message}`, 'error')
  } finally {
    void refresh()
  }
}

async function save() {
  if (!plugin.value) return
  let next: unknown = config.value
  if (!plugin.value.configSchema) {
    try {
      next = configText.value.trim() ? JSON.parse(configText.value) : {}
      configError.value = ''
    } catch {
      configError.value = '不是合法的 JSON'
      return
    }
  }
  saving.value = true
  try {
    await api.patchPlugin(plugin.value.name, { config: next, priority: Number(priority.value) || 0 })
    await refresh()
    push('配置已保存，下一次事件即生效', 'success')
  } catch (e) {
    push(`保存失败：${(e as Error).message}`, 'error')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div>
    <RouterLink to="/plugins" class="mb-3 inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"><ArrowLeft class="size-4" aria-hidden="true" />插件列表</RouterLink>
    <QEmpty v-if="status && !plugin" title="插件不存在" />
    <template v-else-if="plugin">
      <PageHeader :title="plugin.displayName" :description="plugin.description || undefined">
        <RouterLink v-if="plugin.ui && plugin.enabled" :to="`/plugin-ui/${plugin.name}`">
          <QButton size="sm"><PanelsTopLeft class="size-3.5" aria-hidden="true" />打开页面</QButton>
        </RouterLink>
        <div class="-mr-3 flex items-center gap-1">
          <span class="text-sm text-fg-muted">{{ plugin.enabled ? '已启用' : '已禁用' }}</span>
          <QSwitch :model-value="plugin.enabled" label="启用插件" :disabled="!!plugin.error" @update:model-value="toggle" />
        </div>
      </PageHeader>

      <QCard v-if="plugin.error" title="加载失败" class="mb-4">
        <p class="font-mono text-xs text-danger">{{ plugin.error }}</p>
      </QCard>

      <div class="grid gap-4 lg:grid-cols-[1fr_320px]">
        <QCard title="配置" description="保存后写入快照，无需重新部署">
          <form class="flex flex-col gap-4" @submit.prevent="save">
            <SchemaForm v-if="plugin.configSchema" v-model="config" :schema="plugin.configSchema" />
            <QField v-else id="cfg-json" label="配置（JSON）" hint="该插件没有声明 configSchema，直接编辑 JSON" :error="configError">
              <template #default="{ describedBy, invalid }">
                <QTextarea id="cfg-json" v-model="configText" mono :rows="8" :described-by="describedBy" :invalid="invalid" />
              </template>
            </QField>
            <QField id="priority" label="优先级" hint="数值大的先执行；命令命中后默认阻止后续插件">
              <template #default="{ describedBy }">
                <QInput id="priority" v-model="priority" type="number" class="max-w-32" :described-by="describedBy" />
              </template>
            </QField>
            <div><QButton type="submit" variant="primary" :loading="saving">保存</QButton></div>
          </form>
        </QCard>

        <div class="flex flex-col gap-4">
          <QCard title="信息">
            <dl class="flex flex-col gap-2 text-sm">
              <div class="flex justify-between gap-3"><dt class="text-fg-muted">包名</dt><dd class="font-mono text-xs">{{ plugin.name }}</dd></div>
              <div class="flex justify-between gap-3"><dt class="text-fg-muted">版本</dt><dd class="font-mono text-xs">{{ plugin.version }}</dd></div>
              <div class="flex justify-between gap-3">
                <dt class="text-fg-muted">权限</dt>
                <dd class="flex flex-wrap justify-end gap-1"><QBadge v-for="perm in plugin.permissions" :key="perm">{{ perm }}</QBadge><span v-if="!plugin.permissions.length" class="text-fg-subtle">无</span></dd>
              </div>
            </dl>
          </QCard>
          <QCard title="触发器">
            <dl class="flex flex-col gap-3 text-sm">
              <div v-if="plugin.commands.length">
                <dt class="mb-1 text-xs text-fg-muted">命令</dt>
                <dd class="flex flex-col gap-1">
                  <div v-for="c in plugin.commands" :key="c.name" class="flex items-baseline gap-2">
                    <code class="font-mono text-xs">/{{ c.name }}<span v-if="c.aliases?.length" class="text-fg-subtle"> · {{ c.aliases.join(' · ') }}</span></code>
                    <span class="truncate text-xs text-fg-muted">{{ c.description }}</span>
                  </div>
                </dd>
              </div>
              <div v-if="plugin.events.length"><dt class="mb-1 text-xs text-fg-muted">事件</dt><dd class="flex flex-wrap gap-1"><QBadge v-for="e in plugin.events" :key="e">{{ e }}</QBadge></dd></div>
              <div v-if="plugin.buttons.length"><dt class="mb-1 text-xs text-fg-muted">回调按键</dt><dd class="flex flex-wrap gap-1"><QBadge v-for="b in plugin.buttons" :key="b">{{ b }}</QBadge></dd></div>
              <div v-if="plugin.cron.length"><dt class="mb-1 text-xs text-fg-muted">定时</dt><dd class="flex flex-col gap-0.5 font-mono text-xs"><span v-for="c in plugin.cron" :key="c.name">{{ c.cron }} <span class="text-fg-muted">{{ c.name }}</span></span></dd></div>
              <div v-if="plugin.routes.length"><dt class="mb-1 text-xs text-fg-muted">HTTP 路由</dt><dd class="flex flex-col gap-0.5 font-mono text-xs"><span v-for="r in plugin.routes" :key="r.method + r.path">{{ r.method }} /p/{{ plugin.name }}{{ r.path }}<span v-if="r.auth === 'admin'" class="text-fg-muted"> · 需登录</span></span></dd></div>
              <p v-if="!plugin.commands.length && !plugin.events.length && !plugin.buttons.length && !plugin.cron.length && !plugin.routes.length" class="text-xs text-fg-muted">没有声明触发器（可能只提供服务或中间件）。</p>
            </dl>
          </QCard>
        </div>
      </div>
    </template>
  </div>
</template>
