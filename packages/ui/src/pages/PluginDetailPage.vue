<script setup lang="ts">
import { ArrowLeft, PanelsTopLeft } from 'lucide-vue-next'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, ApiError, describeBuild } from '../api/client.js'
import type { GroupScope } from '../api/types.js'
import PageHeader from '../components/PageHeader.vue'
import SchemaForm from '../components/SchemaForm.vue'
import QBadge from '../components/ui/QBadge.vue'
import QButton from '../components/ui/QButton.vue'
import QCard from '../components/ui/QCard.vue'
import QEmpty from '../components/ui/QEmpty.vue'
import QField from '../components/ui/QField.vue'
import QInput from '../components/ui/QInput.vue'
import QSelect from '../components/ui/QSelect.vue'
import QSwitch from '../components/ui/QSwitch.vue'
import QTextarea from '../components/ui/QTextarea.vue'
import { useStatus } from '../composables/useStatus.js'
import { useToast } from '../composables/useToast.js'

const route = useRoute()
const router = useRouter()
const { pluginByName, refresh, status, patchLocal } = useStatus()
const { push } = useToast()

const plugin = computed(() => pluginByName(String(route.params.name)))
const config = ref<Record<string, unknown>>({})
const configText = ref('')
const configError = ref('')
/** 服务端 schema 校验的逐字段错误，喂给 SchemaForm 显示在对应输入框下 */
const fieldErrors = ref<Record<string, string>>({})
const priority = ref('0')
/** 生效的群：all 即不设 groups */
const groupMode = ref<string>('all')
const groupIds = ref('')
const groupError = ref('')
const GROUP_MODES = [
  { value: 'all', label: '所有群' },
  { value: 'allow', label: '只在这些群' },
  { value: 'deny', label: '除了这些群' },
]
const saving = ref(false)
const removing = ref(false)
/** 卸载时是否连插件数据一起清；默认保留（误删不可逆） */
const purgeOnUninstall = ref(false)

watch(
  plugin,
  (p) => {
    if (!p) return
    config.value = { ...((p.config as Record<string, unknown> | null) ?? {}) }
    configText.value = JSON.stringify(p.config ?? {}, null, 2)
    priority.value = String(p.priority)
    groupMode.value = p.groups?.mode ?? 'all'
    groupIds.value = (p.groups?.ids ?? []).join('\n')
  },
  { immediate: true },
)

/** 表单里的群设置 → PATCH 的 groups；「只在这些群」却一个都没填时返回 undefined（等于哪个群都不生效，多半是漏填） */
function groupsPatch(): GroupScope | null | undefined {
  if (groupMode.value === 'all') return null
  const ids = groupIds.value.split(/[\s,，]+/).filter(Boolean)
  if (groupMode.value === 'deny' && !ids.length) return null
  if (!ids.length) return undefined
  return { mode: groupMode.value as GroupScope['mode'], ids }
}

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
  const groups = groupsPatch()
  if (groups === undefined) {
    groupError.value = '至少填一个群 ID'
    return
  }
  groupError.value = ''
  saving.value = true
  fieldErrors.value = {}
  try {
    await api.patchPlugin(plugin.value.name, { config: next, priority: Number(priority.value) || 0, groups })
    await refresh()
    // KV 是最终一致的：本节点立刻生效，其他节点最多约 60 秒，不要承诺「下一次事件即生效」
    push('配置已保存，本节点立即生效，其他节点最多约 60 秒', 'success')
  } catch (e) {
    if (e instanceof ApiError && e.fields.length > 0) {
      fieldErrors.value = Object.fromEntries(e.fields.map((f) => [f.path, f.message]))
      push('配置有 ' + e.fields.length + ' 处不符合要求', 'error')
    } else {
      push(`保存失败：${(e as Error).message}`, 'error')
    }
  } finally {
    saving.value = false
  }
}

/**
 * 卸载：从 D1 清单移除并就地触发重建（重建完成前插件仍在运行）。
 * 卸载成功后回到列表——这个页面接下来就没有对应插件了。
 */
async function uninstall() {
  if (!plugin.value) return
  const name = plugin.value.name
  const purge = purgeOnUninstall.value
  const tail = purge ? '，并清空它的 KV / D1 / R2 数据与面板里的配置（不可恢复）' : '（数据保留，之后可在「存储」页单独清掉）'
  // 依赖它提供的服务的插件：卸载后它们调用 ctx.service 会报错
  const dependents = plugin.value.dependents ?? []
  const warn = dependents.length ? `\n\n注意：${dependents.join('、')} 依赖它提供的服务，卸载后这些插件调用会报错。` : ''
  if (!confirm(`确定卸载 ${name}？它会从插件清单移除并触发一次重建${tail}${warn}`)) return

  removing.value = true
  try {
    const res = await api.uninstallPlugin(name, purge)
    if (res.data.hook === 'failed') {
      push(`已卸载，但插件的 onUninstall 报错：${res.data.hookError ?? '未知原因'}`, 'warning')
    }
    const { text, level } = describeBuild(`${name} 已卸载`, res.build)
    push('buildUuid' in res.build ? `${text}，完成后从列表消失` : text, level)
    if (res.warnings?.length) push(`提醒：${res.warnings.join('；')}`, 'warning')
    await router.push('/plugins')
  } catch (e) {
    push(`卸载失败：${(e as Error).message}`, 'error')
  } finally {
    removing.value = false
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

      <div class="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <QCard title="配置" description="保存后写入快照，无需重新部署">
          <form class="flex flex-col gap-4" @submit.prevent="save">
            <SchemaForm v-if="plugin.configSchema" v-model="config" :schema="plugin.configSchema" :errors="fieldErrors" />
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
            <QField id="group-mode" label="生效的群" hint="只管群里的消息和事件，单聊、频道、定时任务不受影响">
              <template #default="{ describedBy }">
                <QSelect id="group-mode" v-model="groupMode" :options="GROUP_MODES" class="max-w-48" :aria-describedby="describedBy" />
              </template>
            </QField>
            <QField v-if="groupMode !== 'all'" id="group-ids" label="群 ID" hint="在群里发 /sid 查看；每行一个，也可以用空格或逗号分隔" :error="groupError">
              <template #default="{ describedBy, invalid }">
                <QTextarea id="group-ids" v-model="groupIds" mono :rows="3" :described-by="describedBy" :invalid="invalid" />
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

          <QCard v-if="plugin.installed" title="卸载" description="从插件清单移除并触发一次重建；重建完成前它仍在运行">
            <div class="flex flex-col gap-3 text-sm">
              <p v-if="plugin.dependents?.length" class="rounded-md border border-warning/30 bg-warning/10 p-2 text-xs text-warning">
                {{ plugin.dependents.join('、') }} 依赖它提供的服务，卸载后这些插件调用会报错。
              </p>
              <label class="flex cursor-pointer items-start gap-2">
                <input v-model="purgeOnUninstall" type="checkbox" class="mt-0.5" />
                <span>
                  同时清空它的数据
                  <span class="block text-xs text-fg-muted">KV / D1 / R2 与面板里的配置一并删除，不可恢复；不勾选则数据保留，之后可在「存储」页清掉</span>
                </span>
              </label>
              <div><QButton variant="danger" :loading="removing" @click="uninstall">卸载插件</QButton></div>
            </div>
          </QCard>
          <QCard v-else-if="plugin.removing" title="卸载" description="卸载还没生效">
            <p class="text-xs text-fg-muted">
              它已经从插件清单移除，等这次重建完成后下线；在那之前仍在运行。构建失败的话，可以到插件页「未上线的改动」里重新构建，或者撤销卸载。
            </p>
          </QCard>
          <QCard v-else title="卸载" description="这是仓库内置插件">
            <p class="text-xs text-fg-muted">它在仓库的 <code class="font-mono">qqbot.manifest.json</code> 里，从那里移除后重新构建即可下架。</p>
          </QCard>
        </div>
      </div>
    </template>
  </div>
</template>
