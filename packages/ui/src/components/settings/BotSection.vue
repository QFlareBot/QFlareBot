<script setup lang="ts">
/** 机器人：凭证、扫码新建、已保存的机器人、分享链接 */
import { ref } from 'vue'
import BotBindCard from './BotBindCard.vue'
import BotCredentials from './BotCredentials.vue'
import QQShareLink from './QQShareLink.vue'
import SavedBots from './SavedBots.vue'

const saved = ref<InstanceType<typeof SavedBots> | null>(null)
</script>

<template>
  <div class="flex flex-col gap-4">
    <BotCredentials @saved="saved?.reload()" />
    <BotBindCard @created="saved?.reload()" />
    <SavedBots ref="saved" />
    <QQShareLink />
  </div>
</template>
