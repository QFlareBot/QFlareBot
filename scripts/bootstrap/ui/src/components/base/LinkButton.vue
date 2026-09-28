<script setup lang="ts">
/** 长得和 QButton 一样的外链（新标签页打开 Cloudflare 后台） */
import { ArrowUpRight } from 'lucide-vue-next'

withDefaults(defineProps<{ href: string; variant?: 'primary' | 'secondary' | 'ghost'; size?: 'md' | 'lg' }>(), { variant: 'secondary', size: 'md' })
</script>

<template>
  <a
    :href="href"
    target="_blank"
    rel="noopener noreferrer"
    class="inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-full border font-medium whitespace-nowrap no-underline transition-[background-color,border-color,color,transform] duration-(--qb-duration) ease-(--qb-ease) select-none active:scale-[0.97]"
    :class="[
      size === 'lg' ? 'h-10 px-5 text-sm' : 'h-8 px-4 text-sm',
      {
        primary: 'border-transparent bg-primary text-on-primary hover:bg-primary-hover',
        secondary: 'border-border-strong bg-surface text-fg shadow-[0_1px_2px_rgb(0_0_0/0.04)] hover:bg-surface-muted',
        ghost: 'border-transparent bg-transparent text-fg-muted hover:bg-surface-muted hover:text-fg',
      }[variant],
    ]"
  >
    <slot />
    <ArrowUpRight class="size-4 opacity-70" aria-hidden="true" />
  </a>
</template>
