<script setup lang="ts">
/** 标志；几何与 design-system/qflarebot/brand/export.mjs 相同，颜色走面板 token 以跟随深浅色 */
import { useId } from 'vue'

const gap = `qb-logo-gap-${useId()}`
</script>

<template>
  <svg viewBox="0 0 64 64" aria-hidden="true">
    <mask :id="gap" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
      <rect width="64" height="64" fill="#fff" />
      <path d="M47 4Q48.6 14.4 59 16 48.6 17.6 47 28 45.4 17.6 35 16 45.4 14.4 47 4Z" fill="#000" stroke="#000" stroke-width="5" stroke-linejoin="round" />
    </mask>
    <g :mask="`url(#${gap})`">
      <circle cx="29" cy="34" r="18" fill="none" class="stroke-fg" stroke-width="11" />
      <path d="M50.3 43.9 55 59 38.9 55.3 38.2 43.2Z" class="fill-fg" />
    </g>
    <path d="M47 4Q48.6 14.4 59 16 48.6 17.6 47 28 45.4 17.6 35 16 45.4 14.4 47 4Z" class="fill-accent" />
  </svg>
</template>
