<script setup lang="ts">
/** 展开 / 收起时高度平滑过渡；收起后里面的内容不可聚焦 */
defineProps<{ open: boolean }>()
</script>

<template>
  <div
    class="grid transition-[grid-template-rows,opacity] duration-(--qb-duration-slow) ease-out"
    :class="open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'"
    :inert="!open || undefined"
    :aria-hidden="!open || undefined"
  >
    <div class="min-h-0 overflow-hidden"><slot /></div>
  </div>
</template>
