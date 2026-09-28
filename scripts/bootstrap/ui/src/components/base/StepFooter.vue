<template>
  <!-- 放在内容末尾，不贴底：手机浏览器的底栏会挡住固定在底部的元素 -->
  <footer class="mt-2 flex flex-wrap-reverse items-center justify-between gap-3">
    <div class="flex flex-wrap items-center gap-2"><slot name="secondary" /></div>
    <div class="ml-auto flex flex-wrap items-center justify-end gap-2"><slot /></div>
  </footer>
</template>
