<script setup lang="ts">
/** 一次预检的结果：权限、命令、服务、第三方依赖、警告、要补的 DO migrations */
import type { InstallPreview } from '../../api/types.js'
import QBadge from '../ui/QBadge.vue'

defineProps<{ preview: InstallPreview; notice?: string | null }>()
</script>

<template>
  <div class="flex flex-col gap-2">
    <p v-if="preview.manifest.description" class="text-xs text-fg-muted">{{ preview.manifest.description }}</p>
    <dl class="flex flex-col gap-1.5 text-xs">
      <div class="flex flex-wrap items-center gap-1">
        <dt class="mr-1 text-fg-muted">权限</dt>
        <dd class="flex flex-wrap gap-1">
          <QBadge v-for="perm in preview.manifest.permissions" :key="perm">{{ perm }}</QBadge>
          <span v-if="!preview.manifest.permissions.length" class="text-fg-subtle">无</span>
        </dd>
      </div>
      <div v-if="preview.manifest.commands.length" class="flex flex-wrap items-baseline gap-1">
        <dt class="mr-1 text-fg-muted">命令</dt>
        <dd class="font-mono break-all">{{ preview.manifest.commands.map((c) => `/${c}`).join('  ') }}</dd>
      </div>
      <div v-if="preview.manifest.services.length" class="flex flex-wrap items-center gap-1">
        <dt class="mr-1 text-fg-muted">提供服务</dt>
        <dd class="font-mono">{{ preview.manifest.services.join('、') }}</dd>
      </div>
      <div class="flex flex-wrap items-center gap-1">
        <dt class="mr-1 text-fg-muted">第三方依赖</dt>
        <dd class="flex flex-wrap items-center gap-1">
          <QBadge v-for="(range, pkg) in preview.dependencies" :key="pkg"><span class="font-mono">{{ pkg }} {{ range }}</span></QBadge>
          <span v-if="!Object.keys(preview.dependencies ?? {}).length" class="text-fg-subtle">无</span>
          <span v-else class="text-fg-subtle">构建时按插件仓库的 lockfile 安装，与插件一起打包</span>
        </dd>
      </div>
    </dl>
    <ul v-if="preview.warnings.length || notice" class="flex flex-col gap-1 rounded-md bg-warning-bg px-3 py-2 text-xs text-warning">
      <li v-for="w in preview.warnings" :key="w">{{ w }}</li>
      <li v-if="notice">{{ notice }}</li>
    </ul>
    <pre v-if="preview.durableObjects" class="rounded-md bg-warning-bg px-3 py-2 font-mono text-xs whitespace-pre-wrap text-warning">{{ preview.durableObjects.message }}</pre>
  </div>
</template>
