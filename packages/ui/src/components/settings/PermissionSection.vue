<script setup lang="ts">
/** 权限：Bot 管理员名单（逐条输入）与权限不足时的回复 */
import { onMounted, ref } from 'vue'
import { api } from '../../api/client.js'
import { useSettingsPatch } from '../../composables/useSettingsPatch.js'
import QButton from '../ui/QButton.vue'
import QCard from '../ui/QCard.vue'
import QField from '../ui/QField.vue'
import QInput from '../ui/QInput.vue'
import QListInput from '../ui/QListInput.vue'
import QSkeleton from '../ui/QSkeleton.vue'

const { saving, save } = useSettingsPatch()
const loaded = ref(false)
/** 读不到现有名单就不给保存：不然存进去的是空名单，把原来的管理员全清掉 */
const loadError = ref('')
const admins = ref<string[]>([])
const denyReply = ref('')

onMounted(async () => {
  try {
    const { snapshot } = await api.snapshot()
    admins.value = [...(snapshot.admins ?? [])]
    denyReply.value = snapshot.permissionDeniedReply ?? ''
    loaded.value = true
  } catch (e) {
    loadError.value = (e as Error).message
  }
})
</script>

<template>
  <QCard title="权限" description="命令可以声明 bot_admin / group_admin / member 三档，高的一档自动满足低的；按钮回调没有门槛，由插件自己判断">
    <p v-if="loadError" class="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">读取权限设置失败：{{ loadError }}。刷新页面重试。</p>
    <QSkeleton v-else-if="!loaded" :rows="2" label="正在读取权限设置" />
    <form v-else class="flex flex-col gap-5" @submit.prevent="save({ admins, permissionDeniedReply: denyReply.trim() || undefined })">
      <QField id="admins" label="Bot 管理员（超级管理员）" hint="用户的 openid；在会话里发 /sid 可查到自己的。可以一次粘贴多个">
        <template #default="{ describedBy }">
          <QListInput id="admins" v-model="admins" mono separator="any" label="管理员 openid" add-label="添加管理员" :described-by="describedBy" />
        </template>
      </QField>
      <QField id="deny-reply" label="权限不足时回复" hint="留空就静默跳过；填了之后，权限不够且没有别的插件接手时回这句">
        <template #default="{ describedBy }"><QInput id="deny-reply" v-model="denyReply" :described-by="describedBy" /></template>
      </QField>
      <div><QButton type="submit" variant="primary" :loading="saving">保存权限设置</QButton></div>
    </form>
  </QCard>
</template>
