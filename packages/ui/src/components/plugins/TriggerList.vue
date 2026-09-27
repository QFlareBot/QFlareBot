<script setup lang="ts">
/** 插件声明的触发器：命令、事件、回调按键、定时、HTTP 路由 */
import type { PluginInfo } from '../../api/types.js'
import QBadge from '../ui/QBadge.vue'
import QCard from '../ui/QCard.vue'

defineProps<{ plugin: PluginInfo }>()
</script>

<template>
  <QCard title="触发器">
    <dl class="flex flex-col gap-3 text-sm">
      <div v-if="plugin.commands.length">
        <dt class="mb-1 text-xs text-fg-muted">命令</dt>
        <dd class="flex flex-col gap-1">
          <div v-for="c in plugin.commands" :key="c.name" class="flex items-baseline gap-2">
            <code class="shrink-0 font-mono text-xs">/{{ c.name }}<span v-if="c.aliases?.length" class="text-fg-subtle"> · {{ c.aliases.join(' · ') }}</span></code>
            <span class="truncate text-xs text-fg-muted">{{ c.description }}</span>
          </div>
        </dd>
      </div>
      <div v-if="plugin.events.length">
        <dt class="mb-1 text-xs text-fg-muted">事件</dt>
        <dd class="flex flex-wrap gap-1"><QBadge v-for="e in plugin.events" :key="e">{{ e }}</QBadge></dd>
      </div>
      <div v-if="plugin.buttons.length">
        <dt class="mb-1 text-xs text-fg-muted">回调按键</dt>
        <dd class="flex flex-wrap gap-1"><QBadge v-for="b in plugin.buttons" :key="b">{{ b }}</QBadge></dd>
      </div>
      <div v-if="plugin.cron.length">
        <dt class="mb-1 text-xs text-fg-muted">定时</dt>
        <dd class="flex flex-col gap-0.5 font-mono text-xs"><span v-for="c in plugin.cron" :key="c.name">{{ c.cron }} <span class="text-fg-muted">{{ c.name }}</span></span></dd>
      </div>
      <div v-if="plugin.routes.length">
        <dt class="mb-1 text-xs text-fg-muted">HTTP 路由</dt>
        <dd class="flex flex-col gap-0.5 font-mono text-xs break-all">
          <span v-for="r in plugin.routes" :key="r.method + r.path">{{ r.method }} /p/{{ plugin.name }}{{ r.path }}<span v-if="r.auth === 'admin'" class="text-fg-muted"> · 需登录</span></span>
        </dd>
      </div>
      <p v-if="!plugin.commands.length && !plugin.events.length && !plugin.buttons.length && !plugin.cron.length && !plugin.routes.length" class="text-xs text-fg-muted">
        没有声明触发器（可能只提供服务或中间件）。
      </p>
    </dl>
  </QCard>
</template>
