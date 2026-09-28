<script setup lang="ts">
/** 插件自己的配置：有 configSchema 就按表单渲染，没有就直接编辑 JSON */
import { ref, watch } from 'vue'
import { api, ApiError } from '../../api/client.js'
import type { PluginInfo } from '../../api/types.js'
import { useStatus } from '../../composables/useStatus.js'
import { useToast } from '../../composables/useToast.js'
import { fieldLabel } from '../../lib/schemaForm.js'
import SchemaForm from '../SchemaForm.vue'
import QButton from '../ui/QButton.vue'
import QCard from '../ui/QCard.vue'
import QField from '../ui/QField.vue'
import QTextarea from '../ui/QTextarea.vue'

const props = defineProps<{ plugin: PluginInfo }>()
const { refresh } = useStatus()
const { push } = useToast()

const config = ref<Record<string, unknown>>({})
const configText = ref('')
const configError = ref('')
/** 服务端 schema 校验的逐字段错误（键是点分路径），喂给 SchemaForm 显示在对应输入框下 */
const fieldErrors = ref<Record<string, string>>({})
/** SchemaForm 里还不能保存的字段（JSON 解析不了、映射的键重复……）的点分路径：有就不能保存，否则存进去的是改之前的旧值 */
const unparsedFields = ref<string[]>([])
const saving = ref(false)

// 只在服务端的配置真的变了才重置表单：状态刷新会换一个新对象，别把正在改的内容冲掉
watch(
  () => JSON.stringify(props.plugin.config ?? null),
  () => {
    config.value = { ...((props.plugin.config as Record<string, unknown> | null) ?? {}) }
    configText.value = JSON.stringify(props.plugin.config ?? {}, null, 2)
  },
  { immediate: true },
)

async function save() {
  let next: unknown = config.value
  const schema = props.plugin.configSchema
  if (schema && unparsedFields.value.length) {
    const names = unparsedFields.value.map((p) => fieldLabel(p, schema))
    push(`「${names.join('」「')}」还没填好，按字段下的提示改好再保存`, 'error')
    return
  }
  if (!schema) {
    try {
      next = configText.value.trim() ? JSON.parse(configText.value) : {}
      configError.value = ''
    } catch {
      configError.value = '不是合法的 JSON'
      return
    }
  }
  saving.value = true
  fieldErrors.value = {}
  try {
    await api.patchPlugin(props.plugin.name, { config: next })
    await refresh()
    // KV 是最终一致的：本节点立刻生效，其他节点最多约 60 秒，不要承诺「下一次事件即生效」
    push('配置已保存，本节点立即生效，其他节点最多约 60 秒', 'success')
  } catch (e) {
    if (e instanceof ApiError && e.fields.length > 0) {
      fieldErrors.value = Object.fromEntries(e.fields.map((f) => [f.path, f.message]))
      push(`配置有 ${e.fields.length} 处不符合要求`, 'error')
    } else {
      push(`保存失败：${(e as Error).message}`, 'error')
    }
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <QCard title="插件配置" description="保存后写入快照，不用重新部署">
    <form class="flex flex-col gap-4" @submit.prevent="save">
      <SchemaForm v-if="plugin.configSchema" v-model="config" :schema="plugin.configSchema" :errors="fieldErrors" @invalid="unparsedFields = $event" />
      <QField v-else id="cfg-json" label="配置（JSON）" hint="这个插件没有声明 configSchema，直接编辑 JSON" :error="configError">
        <template #default="{ describedBy, invalid }">
          <QTextarea id="cfg-json" v-model="configText" mono :rows="8" :described-by="describedBy" :invalid="invalid" />
        </template>
      </QField>
      <div><QButton type="submit" variant="primary" :loading="saving">保存配置</QButton></div>
    </form>
  </QCard>
</template>
