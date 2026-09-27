<script setup lang="ts">
/** 框架给每个插件的运行规则：优先级、生效的群（只管群消息与群事件） */
import { ref, watch } from 'vue'
import { api } from '../../api/client.js'
import type { GroupScope, PluginInfo } from '../../api/types.js'
import { useStatus } from '../../composables/useStatus.js'
import { useToast } from '../../composables/useToast.js'
import QButton from '../ui/QButton.vue'
import QCard from '../ui/QCard.vue'
import QCollapse from '../ui/QCollapse.vue'
import QField from '../ui/QField.vue'
import QInput from '../ui/QInput.vue'
import QListInput from '../ui/QListInput.vue'
import QSelect from '../ui/QSelect.vue'

const props = defineProps<{ plugin: PluginInfo }>()
const { refresh } = useStatus()
const { push } = useToast()

const GROUP_MODES = [
  { value: 'all', label: '所有群' },
  { value: 'allow', label: '只在这些群' },
  { value: 'deny', label: '除了这些群' },
]
const priority = ref('0')
/** 生效的群：all 即不设 groups */
const groupMode = ref('all')
const groupIds = ref<string[]>([])
const groupError = ref('')
const saving = ref(false)

// 只在服务端的值真的变了才重置，别把正在改的内容冲掉
watch(
  () => JSON.stringify([props.plugin.priority, props.plugin.groups ?? null]),
  () => {
    priority.value = String(props.plugin.priority)
    groupMode.value = props.plugin.groups?.mode ?? 'all'
    groupIds.value = [...(props.plugin.groups?.ids ?? [])]
  },
  { immediate: true },
)

/** 表单 → PATCH 的 groups；「只在这些群」却一个都没填时返回 undefined（等于哪个群都不生效，多半是漏填） */
function groupsPatch(): GroupScope | null | undefined {
  if (groupMode.value === 'all') return null
  if (groupMode.value === 'deny' && !groupIds.value.length) return null
  if (!groupIds.value.length) return undefined
  return { mode: groupMode.value as GroupScope['mode'], ids: groupIds.value }
}

async function save() {
  const groups = groupsPatch()
  if (groups === undefined) {
    groupError.value = '至少填一个群 ID'
    return
  }
  groupError.value = ''
  saving.value = true
  try {
    await api.patchPlugin(props.plugin.name, { priority: Number(priority.value) || 0, groups })
    await refresh()
    push('已保存，本节点立即生效，其他节点最多约 60 秒', 'success')
  } catch (e) {
    push(`保存失败：${(e as Error).message}`, 'error')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <QCard title="运行规则" description="所有插件都有的设置，与插件自己的配置分开保存">
    <form class="flex flex-col gap-4" @submit.prevent="save">
      <QField id="priority" label="优先级" hint="数值大的先执行；命令命中后默认不再交给后面的插件">
        <template #default="{ describedBy }">
          <QInput id="priority" v-model="priority" type="number" class="max-w-32" :described-by="describedBy" />
        </template>
      </QField>
      <!-- 群 ID 收起时不占位：和上面的字段放在同一个块里，间距放进折叠内容 -->
      <div>
        <QField id="group-mode" label="生效的群" hint="只管群里的消息和事件，单聊、频道、定时任务不受影响">
          <template #default="{ describedBy }">
            <QSelect id="group-mode" v-model="groupMode" :options="GROUP_MODES" class="max-w-48" :aria-describedby="describedBy" />
          </template>
        </QField>
        <QCollapse :open="groupMode !== 'all'">
          <div class="pt-4">
            <QField id="group-ids" label="群 ID" hint="在群里发 /sid 查看；可以一次粘贴多个" :error="groupError">
              <template #default="{ describedBy }">
                <QListInput id="group-ids" v-model="groupIds" mono separator="any" label="群 ID" add-label="添加一个群" :described-by="describedBy" />
              </template>
            </QField>
          </div>
        </QCollapse>
      </div>
      <div><QButton type="submit" variant="primary" :loading="saving">保存规则</QButton></div>
    </form>
  </QCard>
</template>
