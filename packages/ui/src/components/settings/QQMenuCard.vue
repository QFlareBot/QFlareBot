<script setup lang="ts">
/** 单聊自定义菜单：仅单聊场景、全局一份，PUT 整体覆盖（5 QPM） */
import { ref } from 'vue'
import { api } from '../../api/client.js'
import { useToast } from '../../composables/useToast.js'
import QButton from '../ui/QButton.vue'
import QCard from '../ui/QCard.vue'
import QCode from '../ui/QCode.vue'
import QField from '../ui/QField.vue'
import QTextarea from '../ui/QTextarea.vue'

const { push } = useToast()
const body = ref('')
const result = ref('')
const busy = ref(false)

async function view() {
  busy.value = true
  result.value = ''
  try {
    const res = await api.qqMenu()
    result.value = JSON.stringify(res, null, 2)
    const menu = (res.data as { menu?: object } | null)?.menu
    if (res.ok && menu) body.value = JSON.stringify({ menu }, null, 2)
  } catch (e) {
    result.value = String((e as Error).message)
  } finally {
    busy.value = false
  }
}

async function save() {
  busy.value = true
  result.value = ''
  try {
    const res = await api.saveQQMenu(JSON.parse(body.value))
    result.value = JSON.stringify(res, null, 2)
    push(res.ok ? '菜单已保存' : `平台返回 ${res.status}`, res.ok ? 'success' : 'error')
  } catch (e) {
    result.value = String((e as Error).message)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <QCard title="单聊自定义菜单" description="单聊会话里的快捷入口，全局一份，保存即整体覆盖。最多 10 项，名称不超过 10 个字符">
    <form class="flex flex-col gap-3" @submit.prevent="save">
      <QField id="menu-body" label="菜单配置（JSON）" hint="type 支持 send_message / link / switch / menu（子菜单 ≤5）；先点「查看当前菜单」拿到现有配置再改">
        <template #default="{ describedBy }"><QTextarea id="menu-body" v-model="body" mono :rows="8" :described-by="describedBy" placeholder='{ "menu": { "items": [ { "type": "send_message", "name": "帮助", "send_message": "/help" } ] } }' /></template>
      </QField>
      <div class="flex flex-wrap gap-2">
        <QButton :loading="busy" @click="view">查看当前菜单</QButton>
        <QButton type="submit" variant="primary" :loading="busy" :disabled="!body.trim()">保存到 QQ</QButton>
      </div>
      <QCode v-if="result" :value="result" />
    </form>
  </QCard>
</template>
