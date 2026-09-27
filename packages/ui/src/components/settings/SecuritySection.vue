<script setup lang="ts">
import { ShieldCheck } from 'lucide-vue-next'
import { useStatus } from '../../composables/useStatus.js'
import QCard from '../ui/QCard.vue'

const { status } = useStatus()
</script>

<template>
  <QCard title="安全建议">
    <ul class="flex flex-col gap-3 text-sm text-fg-muted">
      <li class="flex gap-2.5"><ShieldCheck class="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />把面板域名放到 Cloudflare Access 后面（50 用户内免费），管理密钥就成了第二道锁。</li>
      <li class="flex gap-2.5">
        <ShieldCheck class="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
        <span>轮换 <code class="font-mono text-xs">ADMIN_TOKEN</code> 会让所有会话与插件页面令牌立即失效。</span>
      </li>
      <li class="flex gap-2.5">
        <ShieldCheck class="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
        <span>回调地址与面板同域，QQ 只会请求 <code class="font-mono text-xs">{{ status?.webhookPath ?? '/webhook' }}</code>，其余路径不必对外。</span>
      </li>
    </ul>
  </QCard>
</template>
